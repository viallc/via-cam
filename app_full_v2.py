import os, uuid, time, io, zipfile, hashlib, secrets, re, smtplib
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from flask import Flask, render_template, request, jsonify, redirect, url_for, session, flash, abort, send_file
from dotenv import load_dotenv
from sqlalchemy import create_engine, Column, String, Integer, DateTime, Text, ForeignKey, select, func
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
try:
    import boto3  # Optional: used in production for S3
except Exception:
    boto3 = None
from werkzeug.utils import secure_filename
from PIL import Image
import requests
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
import json
import urllib.parse

load_dotenv()
app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret')

# --- DB ---
DB_URL = os.getenv('DATABASE_URL', 'sqlite:///pickcam.db')
# Normalize Heroku-style postgres URL
if DB_URL.startswith('postgres://'):
    DB_URL = DB_URL.replace('postgres://', 'postgresql://', 1)
engine = create_engine(DB_URL, echo=False, future=True, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, future=True)
Base = declarative_base()

class Project(Base):
    __tablename__ = 'projects'
    id = Column(String, primary_key=True)         # slug
    name = Column(String, nullable=False)
    thumb = Column(String, nullable=True)
    category = Column(String, nullable=True)      # Residential | Commercial
    human_code = Column(String, nullable=True)    # R-0001 / C-0001
    address_line = Column(String, nullable=True)
    city = Column(String, nullable=True)
    state = Column(String, nullable=True)
    zip = Column(String, nullable=True)
    latitude = Column(String, nullable=True)      # For map display
    longitude = Column(String, nullable=True)     # For map display
    created_at = Column(DateTime, default=datetime.utcnow)
    photos = relationship('Photo', back_populates='project', cascade='all, delete-orphan')

class Photo(Base):
    __tablename__ = 'photos'
    id = Column(String, primary_key=True)
    project_id = Column(String, ForeignKey('projects.id'))
    src = Column(Text, nullable=False)
    s3_key = Column(Text, nullable=False)
    author = Column(String, nullable=True)
    gps = Column(String, nullable=True)
    date = Column(String, nullable=True)
    labels = Column(Text, nullable=True)
    # Voice recording fields
    voice_comment = Column(Text, nullable=True)      # AI transcribed voice comment
    voice_confidence = Column(String, nullable=True) # Confidence score of transcription
    # Manual description field (separate from voice comments)
    description = Column(Text, nullable=True)        # Manual description added by user
    created_at = Column(DateTime, default=datetime.utcnow)
    project = relationship('Project', back_populates='photos')

class PhotoComment(Base):
    __tablename__ = 'photo_comments'
    id = Column(String, primary_key=True)
    photo_id = Column(String, ForeignKey('photos.id'))
    author = Column(String, nullable=True)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class User(Base):
    __tablename__ = 'users'
    id = Column(String, primary_key=True)
    email = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=True)  # User's display name
    password_hash = Column(String, nullable=False)
    is_admin = Column(String, nullable=False, default='false')  # 'true' or 'false'
    is_active = Column(String, nullable=False, default='true')   # 'true' or 'false'
    invited_by = Column(String, ForeignKey('users.id'), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class ProjectMember(Base):
    __tablename__ = 'project_members'
    id = Column(String, primary_key=True)
    project_id = Column(String, ForeignKey('projects.id'))
    user_id = Column(String, ForeignKey('users.id'))
    role = Column(String, nullable=False)  # viewer | contributor | admin
    created_at = Column(DateTime, default=datetime.utcnow)

class ShareLink(Base):
    __tablename__ = 'share_links'
    id = Column(String, primary_key=True)
    project_id = Column(String, ForeignKey('projects.id'))
    token = Column(String, unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=True)  # null = never expires
    created_at = Column(DateTime, default=datetime.utcnow)

class UserInvitation(Base):
    __tablename__ = 'user_invitations'
    id = Column(String, primary_key=True)
    email = Column(String, nullable=False)
    token = Column(String, unique=True, nullable=False)
    invited_by = Column(String, ForeignKey('users.id'), nullable=False)
    is_admin = Column(String, nullable=False, default='false')  # 'true' or 'false'
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

def init_db():
    Base.metadata.create_all(engine)
    with SessionLocal() as s:
        # Create sample projects if none exist
        if not s.query(Project).first():
            p1 = Project(id='adventist-church', name='Adventist Church', thumb='/static/img/placeholder1.svg',
                         category='Commercial', human_code='C-0001', address_line='811 E Waterman St', city='Wichita', state='Kansas', zip='67202')
            p2 = Project(id='royal-buffet', name='Royal Buffet', thumb='/static/img/placeholder2.svg',
                         category='Commercial', human_code='C-0002')
            ph1 = Photo(id='seed-a1', project_id=p1.id, src='/static/img/placeholder1.svg', s3_key='local/placeholder1.svg', author='Juan', gps='35.1,-96.2', date='2025-09-01', labels='roof,west')
            ph2 = Photo(id='seed-r1', project_id=p2.id, src='/static/img/placeholder2.svg', s3_key='local/placeholder2.svg', author='Omar', gps='36.0,-95.0', date='2025-09-02', labels='interior,leak')
            s.add_all([p1, p2, ph1, ph2])
            
            # Make admin users admin of all projects
            admin_users = s.query(User).filter(User.is_admin=='true').all()
            for admin_user in admin_users:
                for p in [p1, p2]:
                    # Check if membership already exists
                    existing = s.query(ProjectMember).filter(
                        ProjectMember.project_id==p.id, 
                        ProjectMember.user_id==admin_user.id
                    ).first()
                    if not existing:
                        pm = ProjectMember(id=str(uuid.uuid4()), project_id=p.id, user_id=admin_user.id, role='admin')
                        s.add(pm)
            s.commit()
init_db()

# --- Helpers Auth ---
def hash_password(pw:str)->str:
    salt = secrets.token_hex(8)
    h = hashlib.sha256((salt+pw).encode()).hexdigest()
    return f"{salt}${h}"
def verify_password(pw:str, ph:str)->bool:
    try:
        salt, h = ph.split('$',1)
        return hashlib.sha256((salt+pw).encode()).hexdigest() == h
    except Exception:
        return False

def user_role_for_project(session_db, project_id, user_id):
    mem = session_db.query(ProjectMember).filter(ProjectMember.project_id==project_id, ProjectMember.user_id==user_id).first()
    return mem.role if mem else None

def require_role(proj_id, min_role='viewer'):
    order = {'viewer':1,'contributor':2,'admin':3}
    uid = session.get('uid')
    if not uid: abort(401)
    with SessionLocal() as sdb:
        r = user_role_for_project(sdb, proj_id, uid)
        if not r or order[r] < order[min_role]: abort(403)

def require_admin():
    """Require system admin role"""
    uid = session.get('uid')
    if not uid: abort(401)
    with SessionLocal() as sdb:
        user = sdb.get(User, uid)
        if not user or user.is_admin != 'true' or user.is_active != 'true':
            abort(403)

def is_system_admin(user_id=None):
    """Check if user is system admin"""
    uid = user_id or session.get('uid')
    if not uid: return False
    with SessionLocal() as sdb:
        user = sdb.get(User, uid)
        return user and user.is_admin == 'true' and user.is_active == 'true'

# --- Geocoding Service ---
def geocode_address(address_line, city, state, zip_code):
    """
    Convert address to coordinates using Nominatim (OpenStreetMap) with smart fallback
    Returns: (latitude, longitude) or (None, None) if not found
    """
    try:
        # Build base address components
        if not address_line or not city or not state:
            return None, None
            
        # Create multiple address variations to try
        address_variations = []
        
        # 1. Full address as provided
        full_parts = [address_line, city, state]
        if zip_code: full_parts.append(zip_code)
        address_variations.append(', '.join(full_parts))
        
        # 2. Remove apartment/unit numbers (common patterns)
        if address_line:
            clean_address = address_line
            # Remove patterns like "A 231", "Apt 231", "Unit 231", "#231", "Suite 231"
            import re
            patterns = [
                r'\s+[A-Z]\s+\d+$',          # " A 231"
                r'\s+Apt\s+\w+$',            # " Apt 231" 
                r'\s+Unit\s+\w+$',           # " Unit 231"
                r'\s+Suite\s+\w+$',          # " Suite 231"
                r'\s+#\w+$',                 # " #231"
                r'\s+\w+\s+\w+$'             # Generic " XXX YYY" at end
            ]
            
            for pattern in patterns:
                test_address = re.sub(pattern, '', clean_address, flags=re.IGNORECASE)
                if test_address != clean_address:
                    clean_parts = [test_address, city, state]
                    if zip_code: clean_parts.append(zip_code)
                    address_variations.append(', '.join(clean_parts))
                    break
        
        # 3. Just street + city + state (no zip)
        basic_parts = [address_line, city, state]
        basic_address = ', '.join(basic_parts)
        if basic_address not in address_variations:
            address_variations.append(basic_address)
        
        # Try each variation
        for attempt, full_address in enumerate(address_variations, 1):
            print(f"🔍 Geocoding attempt {attempt}: {full_address}")
            
            # Nominatim API call
            url = "https://nominatim.openstreetmap.org/search"
            params = {
                'q': full_address,
                'format': 'json',
                'limit': 1,
                'addressdetails': 1
            }
            
            headers = {'User-Agent': 'PickCam-App/1.0'}
            response = requests.get(url, params=params, headers=headers, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if data and len(data) > 0:
                    location = data[0]
                    lat = location.get('lat')
                    lon = location.get('lon')
                    
                    if lat and lon:
                        print(f"✅ Geocoded (attempt {attempt}): {full_address} → {lat}, {lon}")
                        return float(lat), float(lon)
            
            # Small delay between attempts to be respectful to the API
            if attempt < len(address_variations):
                import time
                time.sleep(0.5)
        
        print(f"❌ Could not geocode any variation of the address")
        return None, None
        
    except Exception as e:
        print(f"❌ Geocoding error: {e}")
        return None, None

def update_project_coordinates(project):
    """Update project coordinates if address is available but coordinates are missing"""
    if project.latitude and project.longitude:
        return  # Already has coordinates
        
    if not any([project.address_line, project.city, project.state, project.zip]):
        return  # No address information
    
    lat, lon = geocode_address(project.address_line, project.city, project.state, project.zip)
    
    if lat and lon:
        project.latitude = str(lat)
        project.longitude = str(lon)
        print(f"🗺️ Updated coordinates for project {project.name}: {lat}, {lon}")

# --- ID generator ---
def next_human_code(session_db, category:str)->str:
    prefix = 'R' if (category or '').lower().startswith('res') else 'C'
    # get all codes starting with prefix- and compute next
    rows = session_db.query(Project.human_code).filter(Project.human_code.like(f"{prefix}-%")).all()
    maxn = 0
    for (code,) in rows:
        if not code: continue
        m = re.match(rf"{prefix}-(\d+)$", code.strip())
        if m:
            n = int(m.group(1)); maxn = max(maxn, n)
    return f"{prefix}-{maxn+1:04d}"

# --- AWS S3 ---
AWS_REGION = os.getenv('AWS_REGION', 'us-east-1')
S3_BUCKET = os.getenv('S3_BUCKET_ORIGINALS', 'pickcam-photos-original-dev')
CDN_DOMAIN = os.getenv('CDN_DOMAIN', '')

# Initialize S3 client if credentials are provided (production)
if boto3 and os.getenv('AWS_ACCESS_KEY_ID') and os.getenv('AWS_SECRET_ACCESS_KEY'):
    try:
        s3 = boto3.client(
            's3',
            region_name=AWS_REGION,
                  aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY')
        )
    except Exception:
        s3 = None
else:
    s3 = None

# --- Email Configuration ---
SMTP_SERVER = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT = int(os.getenv('SMTP_PORT', '587'))
SMTP_USERNAME = os.getenv('SMTP_USERNAME', '')
SMTP_PASSWORD = os.getenv('SMTP_PASSWORD', '')
FROM_EMAIL = os.getenv('FROM_EMAIL', 'noreply@pickcam.com')
FROM_NAME = os.getenv('FROM_NAME', 'PICKCAM Team')

def send_invitation_email(email, invitation_url, role, expires_at, invited_by_email):
    """Send invitation email to new user"""
    print(f"🔍 Debug - SMTP_USERNAME: {SMTP_USERNAME}")
    print(f"🔍 Debug - SMTP_PASSWORD: {'*' * len(SMTP_PASSWORD) if SMTP_PASSWORD else 'EMPTY'}")
    print(f"🔍 Debug - FROM_EMAIL: {FROM_EMAIL}")
    
    if not SMTP_USERNAME or not SMTP_PASSWORD:
        print(f"⚠️  Email not configured. Manual invitation link: {invitation_url}")
        return False
    
    try:
        # Create message
        msg = MIMEMultipart('alternative')
        msg['Subject'] = 'You\'re invited to join PICKCAM'
        msg['From'] = f'{FROM_NAME} <{FROM_EMAIL}>'
        msg['To'] = email
        
        # Create HTML content
        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>PICKCAM Invitation</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <!-- Header -->
                <div style="background: linear-gradient(135deg, #f97316, #ea580c); padding: 40px 30px; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 800;">
                        PICK<span style="color: #fbbf24;">–</span>CAM
                    </h1>
                    <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0; font-size: 16px;">
                        Professional Photo Management
                    </p>
                </div>
                
                <!-- Content -->
                <div style="padding: 40px 30px;">
                    <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px; font-weight: 700;">
                        You're Invited! 🎉
                    </h2>
                    
                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                        <strong>{invited_by_email}</strong> has invited you to join their PICKCAM workspace. 
                        PICKCAM is a professional photo management platform for construction and project documentation.
                    </p>
                    
                    <!-- Invitation Details -->
                    <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 32px;">
                        <h3 style="color: #1f2937; margin: 0 0 16px 0; font-size: 18px; font-weight: 600;">
                            Invitation Details
                        </h3>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span style="color: #6b7280; font-weight: 500;">Email:</span>
                            <span style="color: #1f2937; font-weight: 600;">{email}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span style="color: #6b7280; font-weight: 500;">Role:</span>
                            <span style="background: {'#dc2626' if role == 'admin' else '#059669'}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">
                                {'System Administrator' if role == 'admin' else 'Standard User'}
                            </span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6b7280; font-weight: 500;">Expires:</span>
                            <span style="color: #dc2626; font-weight: 600;">{expires_at.strftime('%B %d, %Y at %H:%M UTC')}</span>
                        </div>
                    </div>
                    
                    <!-- CTA Button -->
                    <div style="text-align: center; margin-bottom: 32px;">
                        <a href="{invitation_url}" 
                           style="display: inline-block; background: #f97316; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; transition: background-color 0.2s;">
                            Create Your Account
                        </a>
                    </div>
                    
                    <div style="border-top: 1px solid #e5e7eb; padding-top: 20px;">
                        <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin: 0;">
                            <strong>What's next?</strong><br>
                            1. Click the button above to access your invitation<br>
                            2. Confirm your email address<br>
                            3. Create a secure password<br>
                            4. Start managing your project photos!
                        </p>
                    </div>
                </div>
                
                <!-- Footer -->
                <div style="background: #f9fafb; padding: 20px 30px; border-top: 1px solid #e5e7eb; text-align: center;">
                    <p style="color: #6b7280; font-size: 12px; margin: 0;">
                        This invitation expires on {expires_at.strftime('%B %d, %Y at %H:%M UTC')}.<br>
                        If you didn't expect this invitation, you can safely ignore this email.
                    </p>
                </div>
            </div>
        </body>
        </html>
        """
        
        # Create plain text version
        text_content = f"""
        You're invited to join PICKCAM!
        
        {invited_by_email} has invited you to join their PICKCAM workspace.
        
        Invitation Details:
        - Email: {email}
        - Role: {'System Administrator' if role == 'admin' else 'Standard User'}
        - Expires: {expires_at.strftime('%B %d, %Y at %H:%M UTC')}
        
        Create your account: {invitation_url}
        
        What's next?
        1. Click the link above to access your invitation
        2. Confirm your email address
        3. Create a secure password
        4. Start managing your project photos!
        
        This invitation expires on {expires_at.strftime('%B %d, %Y at %H:%M UTC')}.
        If you didn't expect this invitation, you can safely ignore this email.
        
        --
        PICKCAM Team
        """
        
        # Attach parts
        text_part = MIMEText(text_content, 'plain')
        html_part = MIMEText(html_content, 'html')
        msg.attach(text_part)
        msg.attach(html_part)
        
        # Send email
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.starttls()
        server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.send_message(msg)
        server.quit()
        
        print(f"✅ Invitation email sent to {email}")
        return True
        
    except Exception as e:
        print(f"❌ Failed to send email to {email}: {e}")
        return False

# --- Auth Routes ---
@app.route('/auth/register/<token>', methods=['GET','POST'])
def auth_register(token):
    # Verify invitation token
    with SessionLocal() as sdb:
        invitation = sdb.query(UserInvitation).filter(
            UserInvitation.token == token,
            UserInvitation.used_at.is_(None),
            UserInvitation.expires_at > datetime.utcnow()
        ).first()
        if not invitation:
            flash('Invalid or expired invitation link', 'error')
            return redirect(url_for('auth_login'))

    if request.method == 'POST':
        email = request.form.get('email','').strip().lower()
        pw = request.form.get('password','')
        if not email or not pw:
            flash('Email and password are required','error')
            return render_template('auth_register.html', invitation=invitation)

        if email.lower() != invitation.email.lower():
            flash('Email must match the invitation','error')
            return render_template('auth_register.html', invitation=invitation)

        with SessionLocal() as sdb:
            exists = sdb.query(User).filter(User.email==email).first()
            if exists:
                flash('Email already exists','error')
                return render_template('auth_register.html', invitation=invitation)

            # Create user
            uid = str(uuid.uuid4())
            u = User(
                id=uid,
                email=email,
                password_hash=hash_password(pw),
                is_admin=invitation.is_admin,
                is_active='true',
                invited_by=invitation.invited_by
            )
            sdb.add(u)

            # Mark invitation as used
            inv = sdb.query(UserInvitation).filter(UserInvitation.token==token).first()
            if inv:
                inv.used_at = datetime.utcnow()

            sdb.commit()
            session['uid'] = uid
            session['email'] = email
        flash('Account created successfully!', 'success')
            return redirect(url_for('dashboard'))

    return render_template('auth_register.html', invitation=invitation)

@app.route('/auth/login', methods=['GET','POST'])
def auth_login():
    if request.method == 'POST':
        email = request.form.get('email','').strip().lower()
        pw = request.form.get('password','')
        with SessionLocal() as sdb:
            u = sdb.query(User).filter(User.email==email).first()
            if not u or not verify_password(pw, u.password_hash):
                flash('Invalid credentials','error'); return render_template('auth_login.html')
            
            if u.is_active != 'true':
                flash('Account is deactivated. Contact administrator.','error'); return render_template('auth_login.html')
                
            session['uid'] = u.id
            session['email'] = u.email
            session['is_admin'] = u.is_admin == 'true'
            nxt = request.args.get('next') or url_for('dashboard')
            return redirect(nxt)
    return render_template('auth_login.html')

@app.route('/auth/logout')
def auth_logout():
    session.clear()
    return redirect(url_for('auth_login'))

# --- Guards ---
@app.before_request
def protect_pages():
    if request.endpoint in ('static','auth_login','auth_register','share_public','photo_share_public'):
        return
    if request.path.startswith(('/dashboard','/project','/photo','/projects/','/photos')):
        if not session.get('uid'):
            return redirect(url_for('auth_login', next=request.path))

# --- Pages ---
@app.route('/')
def home():
    if session.get('uid'): return redirect(url_for('dashboard'))
    return redirect(url_for('auth_login'))

@app.route('/dashboard')
def dashboard():
    uid = session.get('uid')
    if not uid:
        return redirect(url_for('auth_login'))
    
    with SessionLocal() as s:
        # Get current user to check if admin
        current_user = s.get(User, uid)
        is_admin = current_user and current_user.is_admin == 'true'
        
        if is_admin:
            # Admin sees all projects
        projects = s.query(Project).order_by(Project.created_at.desc()).all()
        else:
            # Normal users only see projects they're members of
            projects = s.query(Project).join(ProjectMember).filter(
                ProjectMember.user_id == uid
            ).order_by(Project.created_at.desc()).all()
        
        # Build enhanced project cards with photo previews
        cards = []
        for p in projects:
            # Get photo count
            photo_count = s.query(Photo).filter(Photo.project_id == p.id).count()
            
            # Get latest photos for thumbnails (max 4 for preview)
            latest_photos = s.query(Photo).filter(Photo.project_id == p.id)\
                             .order_by(Photo.created_at.desc()).limit(4).all()
            
            # Get recent users (authors from latest photos)
            recent_authors = s.query(Photo.author).filter(
                Photo.project_id == p.id, 
                Photo.author.isnot(None)
            ).distinct().limit(3).all()
            
            # Create user chips with initials
            users = []
            for (author,) in recent_authors:
                if author and author.strip():
                    initials = ''.join([word[0].upper() for word in author.strip().split()[:2]])
                    users.append({
                        'label': author,
                        'initials': initials[:2] if initials else author[:2].upper()
                    })
            
            # Get last updated time
            last_photo = s.query(Photo).filter(Photo.project_id == p.id)\
                          .order_by(Photo.created_at.desc()).first()
            last_updated = last_photo.created_at if last_photo else p.created_at
            
            # Create card data structure
            card = type('Card', (), {
                'p': p,
                'count': photo_count,
                'thumbs': [photo.src for photo in latest_photos],
                'users': users,
                'last_updated': last_updated
            })()
            
            cards.append(card)
        
        return render_template('dashboard.html', cards=cards)

@app.route('/project/<proj_id>')
def project_view(proj_id):
    uid = session.get('uid')
    if not uid:
        return redirect(url_for('auth_login'))
    
    q = request.args.get('q','').lower()
    with SessionLocal() as s:
        proj = s.get(Project, proj_id)
        if not proj: return ('Project not found', 404)
        
        # Check if user has access to this project (unless they're admin)
        current_user = s.get(User, uid)
        is_admin = current_user and current_user.is_admin == 'true'
        
        if not is_admin:
            # Check if user is a member of this project
            user_access = s.query(ProjectMember).filter(
                ProjectMember.user_id == uid,
                ProjectMember.project_id == proj_id
            ).first()
            
            if not user_access:
                flash('You do not have access to this project', 'error')
                return redirect(url_for('dashboard'))
        
        photos = s.query(Photo).filter(Photo.project_id==proj_id).order_by(Photo.created_at.desc()).limit(60).all()
        if q:
            photos = [ph for ph in photos if (ph.author and q in ph.author.lower()) or (ph.date and q in ph.date) or (ph.labels and q in ph.labels.lower())]
        
        # Group photos by date for project view too
        from collections import defaultdict
        
        grouped_photos = defaultdict(list)
        
        for photo in photos:
            # Use photo.date if available (when photo was taken), otherwise use created_at (when uploaded)
            if photo.date:
                photo_date = photo.date  # Already in "YYYY-MM-DD" format
            else:
                photo_date = photo.created_at.strftime('%Y-%m-%d')
            
            grouped_photos[photo_date].append(photo)
        
        # Convert to sorted list of (date, photos) tuples, newest first
        sorted_groups = sorted(grouped_photos.items(), key=lambda x: x[0], reverse=True)
        
        return render_template('project.html', project=proj, grouped_photos=sorted_groups, q=q)

@app.route('/photo/<photo_id>')
def photo_detail(photo_id):
    uid = session.get('uid')
    if not uid:
        return redirect(url_for('auth_login'))
    
    with SessionLocal() as s:
        ph = s.get(Photo, photo_id)
        if not ph: return ('Photo not found', 404)
        
        # Check if user has access to the project containing this photo
        current_user = s.get(User, uid)
        is_admin = current_user and current_user.is_admin == 'true'
        
        if not is_admin:
            # Check if user is a member of the project containing this photo
            user_access = s.query(ProjectMember).filter(
                ProjectMember.user_id == uid,
                ProjectMember.project_id == ph.project_id
            ).first()
            
            if not user_access:
                flash('You do not have access to this photo', 'error')
                return redirect(url_for('dashboard'))
        
        proj = s.get(Project, ph.project_id)
        return render_template('photo.html', project=proj, photo=ph)

# --- Global Photos feed & New Project ---
@app.get('/photos')
def photos_feed():
    uid = session.get('uid')
    if not uid:
        return redirect(url_for('auth_login'))
    
    q = request.args.get('q','').lower()
    proj = request.args.get('project')
    limit = max(1, min(int(request.args.get('limit', '60')), 200))
    
    with SessionLocal() as s:
        # Get current user to check if admin
        current_user = s.get(User, uid)
        is_admin = current_user and current_user.is_admin == 'true'
        
        if is_admin:
            # Admin sees all photos
        stmt = select(Photo)
            if proj:
                stmt = stmt.where(Photo.project_id == proj)
            proj_names = {p.id: p.name for p in s.query(Project).all()}
        else:
            # Normal users only see photos from their projects
            user_project_ids = s.query(ProjectMember.project_id).filter(ProjectMember.user_id == uid).subquery()
            stmt = select(Photo).where(Photo.project_id.in_(select(user_project_ids.c.project_id)))
            if proj: 
                # Also check if user has access to the specific project
                user_has_access = s.query(ProjectMember).filter(
                    ProjectMember.user_id == uid,
                    ProjectMember.project_id == proj
                ).first()
                if user_has_access:
                    stmt = stmt.where(Photo.project_id == proj)
                else:
                    # User doesn't have access to this project, show no photos
                    photos = []
                    proj_names = {}
                    return render_template('photos_feed.html', photos=photos, proj_names=proj_names, q=q, proj=proj)
            
            # Only show project names for projects user has access to
            user_projects = s.query(Project).join(ProjectMember).filter(ProjectMember.user_id == uid).all()
            proj_names = {p.id: p.name for p in user_projects}
        
        stmt = stmt.order_by(Photo.created_at.desc()).limit(limit)
        photos = s.execute(stmt).scalars().all()
        if q:
            photos = [ph for ph in photos if (ph.author and q in ph.author.lower()) or (ph.date and q in ph.date) or (ph.labels and q in ph.labels.lower()) or (q in (ph.project_id or ''))]
        
        # Group photos by date
        from collections import defaultdict
        from datetime import datetime
        
        grouped_photos = defaultdict(list)
        
        for photo in photos:
            # Use photo.date if available (when photo was taken), otherwise use created_at (when uploaded)
            if photo.date:
                photo_date = photo.date  # Already in "YYYY-MM-DD" format
            else:
                photo_date = photo.created_at.strftime('%Y-%m-%d')
            
            grouped_photos[photo_date].append(photo)
        
        # Convert to sorted list of (date, photos) tuples, newest first
        sorted_groups = sorted(grouped_photos.items(), key=lambda x: x[0], reverse=True)
        
        return render_template('photos_feed.html', grouped_photos=sorted_groups, proj_names=proj_names, q=q, proj=proj)

@app.get('/projects/new')
def project_new_form():
    return render_template('project_new.html')

@app.post('/projects/new')
def project_new_post():
    name = request.form.get('name','').strip()
    pid = request.form.get('id','').strip().lower().replace(' ','-')
    cat = request.form.get('category','Commercial')
    address_line = request.form.get('address_line','').strip() or None
    city = request.form.get('city','').strip() or None
    state = request.form.get('state','').strip() or None
    zipc = request.form.get('zip','').strip() or None
    if not name:
        flash('Name is required','error'); return redirect(url_for('project_new_form'))
    if not pid:
        pid = re.sub(r'[^a-z0-9]+','-', name.lower()).strip('-')
    with SessionLocal() as s:
        if s.get(Project, pid):
            flash('A project with that ID/slug already exists','error'); return redirect(url_for('project_new_form'))
        code = next_human_code(s, cat)
        p = Project(id=pid, name=name, thumb='/static/img/placeholder1.svg',
                    category=('Residential' if cat.lower().startswith('res') else 'Commercial'),
                    human_code=code, address_line=address_line, city=city, state=state, zip=zipc)
        s.add(p); s.commit()
        uid = session.get('uid')
        if uid: s.add(ProjectMember(id=str(uuid.uuid4()), project_id=p.id, user_id=uid, role='admin')); s.commit()
        flash(f'Project created ({p.human_code})','success')
    return redirect(url_for('project_view', proj_id=pid))

@app.get('/projects/<proj_id>/edit')
def project_edit_form(proj_id):
    """Show project edit form"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as sdb:
        project = sdb.get(Project, proj_id)
        if not project: abort(404)
        
        # Check if user has access to this project
        if not is_system_admin(uid):
            member = sdb.query(ProjectMember).filter(
                ProjectMember.project_id == proj_id,
                ProjectMember.user_id == uid
            ).first()
            if not member: abort(403)
        
        return render_template('project_edit.html', project=project)

@app.post('/projects/<proj_id>/edit')
def project_edit_post(proj_id):
    """Update project information"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as sdb:
        project = sdb.get(Project, proj_id)
        if not project: abort(404)
        
        # Check if user has access to this project
        if not is_system_admin(uid):
            member = sdb.query(ProjectMember).filter(
                ProjectMember.project_id == proj_id,
                ProjectMember.user_id == uid
            ).first()
            if not member: abort(403)
        
        # Update project fields
        name = request.form.get('name','').strip()
        address_line = request.form.get('address_line','').strip() or None
        city = request.form.get('city','').strip() or None
        state = request.form.get('state','').strip() or None
        zipc = request.form.get('zip','').strip() or None
        
        if not name:
            flash('Name is required','error')
            return redirect(url_for('project_edit_form', proj_id=proj_id))
        
        # Update project
        project.name = name
        project.address_line = address_line
        project.city = city
        project.state = state
        project.zip = zipc
        
        # Clear coordinates if address changed - will be re-geocoded on next map load
        project.latitude = None
        project.longitude = None
        
        sdb.commit()
        flash(f'Project updated successfully','success')
        
    return redirect(url_for('project_view', proj_id=proj_id))

@app.post('/api/validate-address')
def api_validate_address():
    """Validate address and return coordinates for real-time feedback"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    data = request.get_json()
    address = data.get('address', '').strip()
    city = data.get('city', '').strip()
    state = data.get('state', '').strip()
    zip_code = data.get('zip', '').strip()
    
    if not address or not city or not state:
        return jsonify({
            'success': False,
            'error': 'Address, city, and state are required'
        })
    
    # Try geocoding
    lat, lon = geocode_address(address, city, state, zip_code)
    
    if lat and lon:
        return jsonify({
            'success': True,
            'latitude': lat,
            'longitude': lon,
            'message': 'Address found successfully'
        })
    else:
        # Generate helpful suggestions
        suggestions = []
        
        # Common fixes
        if any(char in address.lower() for char in ['apt', 'unit', 'suite', '#']):
            clean_addr = address
            import re
            patterns = [r'\s+apt\s+\w+$', r'\s+unit\s+\w+$', r'\s+suite\s+\w+$', r'\s+#\w+$']
            for pattern in patterns:
                clean_addr = re.sub(pattern, '', clean_addr, flags=re.IGNORECASE)
            if clean_addr != address:
                suggestions.append(f'Try without unit: "{clean_addr}"')
        
        # Add "Rd" vs "Road" suggestions
        if 'rd' in address.lower() and 'road' not in address.lower():
            suggestions.append(address.replace('Rd', 'Road').replace('rd', 'Road'))
        elif 'road' in address.lower():
            suggestions.append(address.replace('Road', 'Rd').replace('road', 'Rd'))
            
        # Add "St" vs "Street" suggestions  
        if 'st' in address.lower() and 'street' not in address.lower():
            suggestions.append(address.replace('St', 'Street').replace('st', 'Street'))
        elif 'street' in address.lower():
            suggestions.append(address.replace('Street', 'St').replace('street', 'St'))
        
        return jsonify({
            'success': False,
            'error': 'Address not found',
            'suggestions': suggestions[:3]  # Limit to 3 suggestions
        })

# --- Public share ---
@app.get('/p/<proj_id>')
def share_public(proj_id):
    token = request.args.get('t')
    if not token: abort(404)
    with SessionLocal() as sdb:
        sl = sdb.query(ShareLink).filter(ShareLink.project_id==proj_id, ShareLink.token==token).first()
        if not sl: abort(404)
        if sl.expires_at and datetime.utcnow() > sl.expires_at: abort(410)
        proj = sdb.get(Project, proj_id)
        if not proj: abort(404)
        photos = sdb.query(Photo).filter(Photo.project_id==proj_id).order_by(Photo.created_at.desc()).limit(60).all()
        return render_template('project_public.html', project=proj, photos=photos, q='')

# --- Members & share links (admin only) ---
@app.get('/projects/<proj_id>/members')
def members_view(proj_id):
    with SessionLocal() as sdb:
        # require admin
        uid = session.get('uid')
        if not uid: abort(401)
        # lightweight check
        role = user_role_for_project(sdb, proj_id, uid)
        if role != 'admin': abort(403)
        proj = sdb.get(Project, proj_id)
        rows = sdb.execute(select(ProjectMember, User).join(User, ProjectMember.user_id==User.id).where(ProjectMember.project_id==proj_id)).all()
        return render_template('members.html', project=proj, rows=rows)

@app.post('/projects/<proj_id>/invite')
def invite_user(proj_id):
    with SessionLocal() as sdb:
        uid = session.get('uid')
        if not uid: abort(401)
        role = user_role_for_project(sdb, proj_id, uid)
        if role != 'admin': abort(403)
        email = request.form.get('email','').strip().lower()
        role_new = request.form.get('role','viewer')
        if role_new not in ('viewer','contributor','admin'): role_new='viewer'
        u = sdb.query(User).filter(User.email==email).first()
        if not u:
            nid = str(uuid.uuid4())
            u = User(id=nid, email=email, password_hash=hash_password('changeme'))
            sdb.add(u); sdb.commit()
        mem = sdb.query(ProjectMember).filter(ProjectMember.project_id==proj_id, ProjectMember.user_id==u.id).first()
        if not mem:
            sdb.add(ProjectMember(id=str(uuid.uuid4()), project_id=proj_id, user_id=u.id, role=role_new))
        else:
            mem.role = role_new
        sdb.commit()
        flash(f'Invited {email} as {role_new}. Initial password: changeme','success')
    return redirect(url_for('members_view', proj_id=proj_id))

@app.get('/projects/<proj_id>/sharelinks')
def share_links_view(proj_id):
    with SessionLocal() as sdb:
        uid = session.get('uid')
        if not uid: abort(401)
        if user_role_for_project(sdb, proj_id, uid) != 'admin': abort(403)
        proj = sdb.get(Project, proj_id)
        links = sdb.query(ShareLink).filter(ShareLink.project_id==proj_id).order_by(ShareLink.created_at.desc()).all()
        return render_template('share_links.html', project=proj, links=links)

@app.post('/projects/<proj_id>/sharelinks')
def share_links_create(proj_id):
    with SessionLocal() as sdb:
        uid = session.get('uid')
        if not uid: abort(401)
        if user_role_for_project(sdb, proj_id, uid) != 'admin': abort(403)
        days = int(request.form.get('days','7') or '7')
        token = secrets.token_urlsafe(16)
        sdb.add(ShareLink(id=str(uuid.uuid4()), project_id=proj_id, token=token,
                          expires_at=(datetime.utcnow()+timedelta(days=days)) if days>0 else None))
        sdb.commit()
    flash('Link created', 'success')
    return redirect(url_for('share_links_view', proj_id=proj_id))

# --- Admin Routes ---
@app.route('/admin/users')
def admin_users():
    require_admin()
    with SessionLocal() as sdb:
        users = sdb.query(User).order_by(User.created_at.desc()).all()
        invitations = sdb.query(UserInvitation).filter(UserInvitation.used_at.is_(None)).order_by(UserInvitation.created_at.desc()).all()
        return render_template('admin_users.html', users=users, invitations=invitations)

@app.post('/admin/invite')
def admin_invite():
    require_admin()
    email = request.form.get('email','').strip().lower()
    is_admin = request.form.get('is_admin') == 'on'
    
    if not email:
        flash('Email is required', 'error')
        return redirect(url_for('admin_users'))
    
    with SessionLocal() as sdb:
        # Check if user already exists
        existing_user = sdb.query(User).filter(User.email == email).first()
        if existing_user:
            flash('User already exists', 'error')
            return redirect(url_for('admin_users'))
        
        # Check if invitation already exists
        existing_invite = sdb.query(UserInvitation).filter(
            UserInvitation.email == email,
            UserInvitation.used_at.is_(None)
        ).first()
        if existing_invite:
            flash('Invitation already sent to this email', 'error')
            return redirect(url_for('admin_users'))
        
        # Create invitation
        token = secrets.token_urlsafe(32)
        invitation = UserInvitation(
            id=str(uuid.uuid4()),
            email=email,
            token=token,
            invited_by=session.get('uid'),
            is_admin='true' if is_admin else 'false',
            expires_at=datetime.utcnow() + timedelta(days=7)
        )
        sdb.add(invitation)
        sdb.commit()
        
        # Send invitation email
        invite_url = request.url_root.rstrip('/') + url_for('auth_register', token=token)
        invited_by_user = sdb.get(User, session.get('uid'))
        invited_by_email = invited_by_user.email if invited_by_user else 'System Administrator'
        
        role_text = 'admin' if is_admin else 'user'
        email_sent = send_invitation_email(
            email=email,
            invitation_url=invite_url,
            role=role_text,
            expires_at=invitation.expires_at,
            invited_by_email=invited_by_email
        )
        
        if email_sent:
            flash(f'Invitation sent to {email}! They will receive an email with the registration link.', 'success')
        else:
            flash(f'Invitation created! Send this link manually: {invite_url}', 'success')
        
    return redirect(url_for('admin_users'))

@app.post('/admin/users/<user_id>/toggle')
def admin_toggle_user(user_id):
    require_admin()
    with SessionLocal() as sdb:
        user = sdb.get(User, user_id)
        if not user:
            flash('User not found', 'error')
            return redirect(url_for('admin_users'))
        
        # Don't allow deactivating yourself
        if user.id == session.get('uid'):
            flash('Cannot deactivate your own account', 'error')
            return redirect(url_for('admin_users'))
        
        user.is_active = 'false' if user.is_active == 'true' else 'true'
        sdb.commit()
        
        status = 'activated' if user.is_active == 'true' else 'deactivated'
        flash(f'User {user.email} {status}', 'success')
        
    return redirect(url_for('admin_users'))

@app.post('/admin/users/<user_id>/edit')
def admin_edit_user(user_id):
    """Edit user name"""
    require_admin()
    with SessionLocal() as sdb:
        user = sdb.get(User, user_id)
        if not user:
            flash('User not found', 'error')
            return redirect(url_for('admin_users'))
        
        name = request.form.get('name', '').strip()
        if name:
            user.name = name
            sdb.commit()
            flash(f'User name updated to "{name}"', 'success')
        else:
            flash('Name cannot be empty', 'error')
            
        return redirect(url_for('admin_users'))

@app.post('/admin/users/<user_id>/delete')
def admin_delete_user(user_id):
    """Delete user permanently"""
    require_admin()
    
    # Prevent self-deletion
    if user_id == session.get('uid'):
        flash('Cannot delete your own account', 'error')
        return redirect(url_for('admin_users'))
    
    with SessionLocal() as sdb:
        user = sdb.get(User, user_id)
        if not user:
            flash('User not found', 'error')
            return redirect(url_for('admin_users'))
        
        user_name = user.name or user.email
        
        # Remove user from all projects
        project_memberships = sdb.query(ProjectMember).filter(ProjectMember.user_id == user_id).all()
        for membership in project_memberships:
            sdb.delete(membership)
        
        # Delete user
        sdb.delete(user)
        sdb.commit()
        
        flash(f'User "{user_name}" deleted permanently', 'success')
        return redirect(url_for('admin_users'))

# --- DAR System API Endpoints ---
@app.post('/api/fetch-monday')
def api_fetch_monday_data():
    """Simulate Monday.com data fetch using PICK-CAM project data"""
    uid = session.get('uid')
    if not uid: 
        # For DAR integration, allow access if coming from reports page
        return jsonify(error='Authentication required. Please login to PICK-CAM first.'), 401
    
    data = request.get_json()
    v_id = data.get('v_id', '').strip()
    
    if not v_id:
        return jsonify(error='V-ID is required'), 400
    
    with SessionLocal() as s:
        # Try to find project by ID or name containing v_id
        project = s.query(Project).filter(
            (Project.id == v_id) | 
            (Project.name.ilike(f'%{v_id}%')) |
            (Project.human_code == v_id)
        ).first()
        
        if not project:
            return jsonify(
                error=f'Project not found for V-ID: {v_id}',
                message='No project found with that ID or name',
                v_id=v_id,
                searched_pages=1
            ), 404
        
        # Determine category from human_code or category field
        category = project.category
        if not category and project.human_code:
            if project.human_code.startswith('C-'):
                category = 'Commercial'
            elif project.human_code.startswith('R-'):
                category = 'Residential'
        
        # Return project data in DAR format
        return jsonify({
            # Property Information fields - CORRECTED FIELD NAMES
            'name': project.name or 'Unknown Project',  # Business Name
            'business_name': project.name or 'Unknown Project',  # Business Name (DAR expects this)
            'property_name': project.name or 'Unknown Project',  # Property Name (alternative)
            'property_address': project.address_line or '',  # Street Address (DAR expects this)
            'address': project.address_line or '',  # Street Address (backup)
            'city': project.city or '',  # City
            'state': project.state or '',  # State
            'zipcode': project.zip or '',  # ZIP Code (DAR expects this)
            'zip': project.zip or '',  # ZIP Code (backup)
            'full_address': f"{project.address_line or ''}, {project.city or ''}, {project.state or ''} {project.zip or ''}".strip(', '),
            
            # Contact Information (defaults)
            'phone': '(555) 123-4567',  # Default phone
            'email': 'contact@example.com',  # Default email
            'company': project.name or 'Unknown Company',  # Use project name as company
            
            # Project Identification
            'v_id': v_id,
            'project_id': project.id,  # This is actually the slug
            'project_slug': project.id,  # Same as project_id since id IS the slug
            'human_code': project.human_code or '',
            'category': category or 'Residential',
            'property_type': category or 'Residential'
        })

@app.get('/api/projects/<project_id>/dar-photos')
def api_dar_photos(project_id):
    """Get project photos for DAR system"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as s:
        # Find project by ID (which is actually the slug)
        project = s.get(Project, project_id)
        if not project:
            return jsonify(error='Project not found'), 404
        
        photos = s.query(Photo).filter(Photo.project_id == project.id).order_by(Photo.created_at.desc()).all()
        
        # Format photos for DAR system
        photo_data = []
        for photo in photos:
            # Convert relative path to full URL using current host
            try:
                base = request.host_url.rstrip('/')
            except Exception:
                base = ''
            photo_url = f"{base}{photo.src}" if (photo.src or '').startswith('/') else photo.src
            
            photo_data.append({
                'id': photo.id,
                'url': photo_url,
                'src': photo.src,
                'author': photo.author or 'Unknown',
                'date': photo.date or photo.created_at.strftime('%Y-%m-%d') if photo.created_at else 'Unknown',
                'gps': photo.gps,
                'labels': photo.labels,
                'description': photo.description,
                'voice_comment': photo.voice_comment
            })
        
        return jsonify({
            'project_id': project_id,
            'project_name': project.name,
            'address_line': project.address_line or '',
            'city': project.city or '',
            'state': project.state or '',
            'zip': project.zip or '',
            'full_address': f"{project.address_line or ''}, {project.city or ''}, {project.state or ''} {project.zip or ''}".strip(', '),
            'photos': photo_data,
            'total_photos': len(photo_data)
        })

@app.post('/admin/invitations/<invitation_id>/delete')
def admin_delete_invitation(invitation_id):
    require_admin()
    with SessionLocal() as sdb:
        invitation = sdb.get(UserInvitation, invitation_id)
        if not invitation:
            flash('Invitation not found', 'error')
            return redirect(url_for('admin_users'))
        
        # Only delete unused invitations
        if invitation.used_at:
            flash('Cannot delete used invitations', 'error')
            return redirect(url_for('admin_users'))
        
        email = invitation.email
        sdb.delete(invitation)
        sdb.commit()
        
        flash(f'Invitation for {email} deleted successfully', 'success')
    
    return redirect(url_for('admin_users'))

# --- Upload APIs ---

@app.post('/api/photos/presign')
def api_presign():
    data = request.get_json(force=True)
    project_id = data.get('project_id')
    filename = data.get('filename')
    content_type = data.get('content_type', 'application/octet-stream')
    if not project_id or not filename:
        return jsonify(error='project_id and filename are required'), 400
    # Allow any authenticated user to get presigned URLs
    uid = session.get('uid')
    if not uid: abort(401)
    with SessionLocal() as sdb:
        # Verify project exists
        project = sdb.get(Project, project_id)
        if not project:
            return jsonify(error='Project not found'), 404

    key = f"{project_id}/{int(time.time())}-{uuid.uuid4()}-{secure_filename(filename)}"
    if not s3:
        return jsonify(error='S3 not configured'), 400
    try:
        url = s3.generate_presigned_url(
            ClientMethod='put_object',
            Params={'Bucket': S3_BUCKET, 'Key': key, 'ContentType': content_type},
            ExpiresIn=900, HttpMethod='PUT'
        )
    except Exception as e:
        return jsonify(error=str(e)), 500
    return jsonify(upload_url=url, s3_key=key)

@app.post('/api/photos/register')
def api_register():
    data = request.get_json(force=True)
    project_id = data.get('project_id')
    s3_key = data.get('s3_key')
    author = data.get('author')
    date = data.get('date', datetime.utcnow().strftime('%Y-%m-%d'))
    gps = data.get('gps')
    labels = data.get('labels')
    if not project_id or not s3_key:
        return jsonify(error='project_id and s3_key are required'), 400

    uid = session.get('uid')
    if not uid: abort(401)
    # Allow any authenticated user to register photos
    with SessionLocal() as sdb:
        # Verify project exists
        project = sdb.get(Project, project_id)
        if not project:
            return jsonify(error='Project not found'), 404

    src = f"https://{os.getenv('CDN_DOMAIN')}/{s3_key}" if os.getenv('CDN_DOMAIN') else f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{s3_key}"
    with SessionLocal() as s:
        proj = s.get(Project, project_id)
        if not proj: return jsonify(error='project not found'), 404
        pid = str(uuid.uuid4())
        ph = Photo(id=pid, project_id=project_id, src=src, s3_key=s3_key, author=author, date=date, gps=gps, labels=labels)
        s.add(ph); proj.thumb = src; s.commit()
        return jsonify(ok=True, photo_id=pid, src=src)

ALLOWED_EXT = {'.jpg','.jpeg','.png','.webp','.gif','.heic','.heif'}
MAX_BYTES = 25 * 1024 * 1024
UPLOAD_DIR = os.path.join(os.getcwd(), 'static', 'uploads')
os.makedirs(UPLOAD_DIR, exist_ok=True)

def _project_dir(project_id: str) -> str:
    path = os.path.join(UPLOAD_DIR, project_id)
    os.makedirs(path, exist_ok=True)
    return path

def _project_notes_path(project_id: str) -> str:
    return os.path.join(_project_dir(project_id), 'notes.txt')

@app.post('/api/photos/local_upload')
def api_local_upload():
    if os.getenv('ALLOW_LOCAL_UPLOAD', 'true').lower() != 'true':
        return jsonify(error='Local upload disabled in this environment'), 403
    project_id = request.form.get('project_id')
    f = request.files.get('file')
    if not project_id or not f:
        return jsonify(error='project_id and file are required'), 400
    uid = session.get('uid')
    if not uid: abort(401)
    
    # Allow any authenticated user to upload photos
    with SessionLocal() as sdb:
        # Verify project exists
        project = sdb.get(Project, project_id)
        if not project:
            return jsonify(error='Project not found'), 404
    if request.content_length and request.content_length > MAX_BYTES:
        return jsonify(error='file too large'), 413
    ext = os.path.splitext(f.filename or '')[1].lower()
    if ext not in ALLOWED_EXT: return jsonify(error='extension not allowed'), 400
    filename = secure_filename(f.filename or f'photo{ext}')
    proj_dir = os.path.join(UPLOAD_DIR, project_id); os.makedirs(proj_dir, exist_ok=True)
    save_path = os.path.join(proj_dir, filename); f.save(save_path)
    web_path = f'/static/uploads/{project_id}/{filename}'
    with SessionLocal() as s:
        proj = s.get(Project, project_id)
        if not proj: return jsonify(error='project not found'), 404
        pid = str(uuid.uuid4())
        # Get voice comment data if provided
        voice_comment = request.form.get('voice_comment', '').strip()
        voice_confidence = request.form.get('voice_confidence', '0')
        
        # Get GPS data if provided
        gps_data = request.form.get('gps', '').strip()

        # Optional: inherit metadata from source photo id
        source_photo_id = request.form.get('source_photo_id', '').strip()
        inherit_desc = None
        inherit_voice_comment = None
        inherit_voice_confidence = None
        inherit_gps = None
        if source_photo_id:
            try:
                srcp = s.get(Photo, source_photo_id)
                if srcp:
                    inherit_desc = srcp.description
                    inherit_voice_comment = srcp.voice_comment
                    inherit_voice_confidence = srcp.voice_confidence
                    inherit_gps = srcp.gps
            except Exception:
                pass
        
        # Get user name for author field
        user_id = session.get('uid')
        author_name = 'Local'
        if user_id:
            user = s.get(User, user_id)
            if user:
                author_name = user.name or user.email.split('@')[0] if user.email else 'Unknown'
        
        # Create photo with voice and GPS data
        ph = Photo(
            id=pid, 
            project_id=project_id, 
            src=web_path, 
            s3_key=web_path, 
            author=author_name,
            date=datetime.utcnow().strftime('%Y-%m-%d'),
            gps=(gps_data or inherit_gps) or None,
            voice_comment=(voice_comment or inherit_voice_comment) or None,
            voice_confidence=(voice_comment and voice_confidence) or inherit_voice_confidence,
            description=inherit_desc
        )
        s.add(ph); proj.thumb = web_path; s.commit()
        return jsonify(ok=True, photo_id=pid, src=web_path)

@app.get('/api/photos/<photo_id>/metadata')
def api_photo_metadata(photo_id):
    """Get photo metadata including voice comments, tags, and description"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as s:
        photo = s.get(Photo, photo_id)
        if not photo:
            return jsonify(error='Photo not found'), 404
        
        # Get project info
        project = s.get(Project, photo.project_id)
        
        # Fetch comments
        comments_rows = s.query(PhotoComment).filter(PhotoComment.photo_id==photo_id).order_by(PhotoComment.created_at.asc()).all()
        comments = [
            {
                'author': (row.author or 'Anonymous'),
                'content': row.content,
                'date': row.created_at.strftime('%Y-%m-%d %H:%M') if row.created_at else ''
            } for row in comments_rows
        ]

        # Build response data
        metadata = {
            'ok': True,
            'photo_id': photo.id,
            'tags': photo.labels or '',
            'description': photo.description or '',  # Use separate description field
            'voice_comment': photo.voice_comment,
            'voice_confidence': photo.voice_confidence,
            'author': photo.author,
            'date': photo.date,
            'gps': photo.gps,
            'created_at': photo.created_at.isoformat() if photo.created_at else None,
            'comments': comments,
            'project': {
                'id': project.id,
                'name': project.name,
                'address': f"{project.address_line or ''}, {project.city or ''}, {project.state or ''} {project.zip or ''}".strip(', '),
                'city': project.city,
                'state': project.state
            } if project else None
        }
        
        return jsonify(metadata)

@app.post('/api/photos/<photo_id>/description')
def api_update_photo_description(photo_id):
    """Update photo description"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    data = request.get_json()
    if not data:
        return jsonify(error='No data provided'), 400
    
    description = data.get('description', '').strip()
    
    with SessionLocal() as s:
        photo = s.get(Photo, photo_id)
        if not photo:
            return jsonify(error='Photo not found'), 404
        
        # Update the separate description field
        photo.description = description
        s.commit()
        
        return jsonify(ok=True, message='Description updated successfully')

@app.post('/api/photos/<photo_id>/comments')
def api_post_photo_comment(photo_id):
    """Add a comment to a photo"""
    uid = session.get('uid')
    if not uid: abort(401)
    data = request.get_json(force=True)
    content = (data.get('content') or '').strip()
    if not content:
        return jsonify(error='content is required'), 400
    with SessionLocal() as sdb:
        photo = sdb.get(Photo, photo_id)
        if not photo:
            return jsonify(error='Photo not found'), 404
        # Find user name/email for author field
        user = sdb.get(User, uid)
        author = (user.name or (user.email.split('@')[0] if user and user.email else 'User')) if user else 'User'
        c = PhotoComment(id=str(uuid.uuid4()), photo_id=photo_id, author=author, content=content, created_at=datetime.utcnow())
        sdb.add(c)
        sdb.commit()
        return jsonify(ok=True)

@app.post('/api/photos/<photo_id>/tags')
def api_update_photo_tags(photo_id):
    """Update photo tags/labels"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    data = request.get_json()
    if not data:
        return jsonify(error='No data provided'), 400
    
    tags = data.get('tags', '').strip()
    
    with SessionLocal() as s:
        photo = s.get(Photo, photo_id)
        if not photo:
            return jsonify(error='Photo not found'), 404
        
        photo.labels = tags
        s.commit()
        
        return jsonify(ok=True, message='Tags updated successfully')

@app.post('/api/photos/local_upload_multiple')
def api_local_upload_multiple():
    """Handle multiple file uploads at once"""
    project_id = request.form.get('project_id')
    files = request.files.getlist('files')  # Get multiple files
    
    if not project_id or not files:
        return jsonify(error='project_id and files are required'), 400
    
    uid = session.get('uid')
    if not uid: abort(401)
    
    # Allow any authenticated user to upload photos
    with SessionLocal() as sdb:
        # Verify project exists
        project = sdb.get(Project, project_id)
        if not project:
            return jsonify(error='Project not found'), 404
    
    # Validate total size
    total_size = sum(f.content_length or 0 for f in files if hasattr(f, 'content_length'))
    if total_size > MAX_BYTES * len(files):  # Allow more space for multiple files
        return jsonify(error=f'Total files size too large. Max {MAX_BYTES * len(files)} bytes'), 413
    
    results = []
    success_count = 0
    
    for file in files:
        try:
            # Validate individual file
            if not file.filename:
                results.append({'filename': 'unknown', 'success': False, 'error': 'No filename'})
                continue
                
            ext = os.path.splitext(file.filename)[1].lower()
            if ext not in ALLOWED_EXT:
                results.append({'filename': file.filename, 'success': False, 'error': 'Extension not allowed'})
                continue
            
            # Save file
            filename = secure_filename(file.filename)
            proj_dir = os.path.join(UPLOAD_DIR, project_id)
            os.makedirs(proj_dir, exist_ok=True)
            save_path = os.path.join(proj_dir, filename)
            file.save(save_path)
            
            web_path = f'/static/uploads/{project_id}/{filename}'
            
            # Register in database
            with SessionLocal() as s:
                proj = s.get(Project, project_id)
                if not proj:
                    results.append({'filename': file.filename, 'success': False, 'error': 'Project not found'})
                    continue
                    
                pid = str(uuid.uuid4())
                ph = Photo(
                    id=pid, 
                    project_id=project_id, 
                    src=web_path, 
                    s3_key=web_path, 
                    author=session.get('email','Local'),
                    date=datetime.utcnow().strftime('%Y-%m-%d')
                )
                s.add(ph)
                
                # Update project thumbnail to the first successful upload
                if success_count == 0:
                    proj.thumb = web_path
                
                s.commit()
                
                results.append({
                    'filename': file.filename, 
                    'success': True, 
                    'photo_id': pid, 
                    'src': web_path
                })
                success_count += 1
                
        except Exception as e:
            results.append({'filename': file.filename, 'success': False, 'error': str(e)})
    
        return jsonify(
        ok=True, 
        results=results, 
        success_count=success_count, 
        total_count=len(files)
    )

# --- Photo Actions API ---
@app.post('/api/projects/<project_id>/cover')
def api_set_cover_photo(project_id):
    """Set project cover photo"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    data = request.get_json()
    photo_id = data.get('photo_id')
    
    if not photo_id:
        return jsonify(error='photo_id is required'), 400
    
    with SessionLocal() as sdb:
        # Allow any authenticated user to set cover photo
        project = sdb.get(Project, project_id)
        if not project:
            return jsonify(error='Project not found'), 404
        
        # Get photo
        photo = sdb.get(Photo, photo_id)
        
        if not photo or not project:
            return jsonify(error='Photo or project not found'), 404
        
        if photo.project_id != project_id:
            return jsonify(error='Photo does not belong to this project'), 400
        
        # Update project cover
        project.thumb = photo.src
        sdb.commit()
        
        return jsonify(ok=True)

@app.delete('/api/photos/<photo_id>')
def api_delete_photo(photo_id):
    """Delete photo"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as sdb:
        photo = sdb.get(Photo, photo_id)
        if not photo:
            return jsonify(error='Photo not found'), 404
        
        # Allow any authenticated user to delete photos
        # Delete photo file if it's local
        if photo.src and photo.src.startswith('/static/uploads/'):
            try:
                file_path = os.path.join(os.getcwd(), photo.src.lstrip('/'))
                if os.path.exists(file_path):
                    os.remove(file_path)
            except Exception as e:
                print(f"Failed to delete file {photo.src}: {e}")
        
        # Delete from database
        sdb.delete(photo)
        sdb.commit()
        
        return jsonify(ok=True)

@app.post('/api/photos/<photo_id>/duplicate')
def api_duplicate_photo(photo_id):
    """Duplicate photo"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as sdb:
        original_photo = sdb.get(Photo, photo_id)
        if not original_photo:
            return jsonify(error='Photo not found'), 404
        
        # Allow any authenticated user to duplicate photos
        # Create new photo with same data but new ID
        new_photo_id = str(uuid.uuid4())
        
        # Handle file duplication for local files
        new_src = original_photo.src
        new_s3_key = original_photo.s3_key
        
        if original_photo.src and original_photo.src.startswith('/static/uploads/'):
            try:
                # Parse original file path
                original_path = os.path.join(os.getcwd(), original_photo.src.lstrip('/'))
                if os.path.exists(original_path):
                    # Create new filename with duplicate suffix
                    path_parts = os.path.splitext(original_path)
                    new_filename = f"{os.path.basename(path_parts[0])}_duplicate_{int(time.time())}{path_parts[1]}"
                    new_path = os.path.join(os.path.dirname(original_path), new_filename)
                    
                    # Copy file
                    import shutil
                    shutil.copy2(original_path, new_path)
                    
                    # Update paths for new photo
                    new_src = original_photo.src.replace(os.path.basename(original_path), new_filename)
                    new_s3_key = new_src
                    
            except Exception as e:
                print(f"Failed to duplicate file {original_photo.src}: {e}")
                # Continue with same src if file copy fails
        
        # Create duplicate photo record
        duplicate_photo = Photo(
            id=new_photo_id,
            project_id=original_photo.project_id,
            src=new_src,
            s3_key=new_s3_key,
            author=session.get('email', 'Unknown'),
            date=datetime.now(timezone.utc).strftime('%Y-%m-%d'),
            gps=original_photo.gps,
            labels=f"{original_photo.labels or ''} duplicate".strip(),
            description=original_photo.description,
            voice_comment=original_photo.voice_comment,
            voice_confidence=original_photo.voice_confidence
        )
        
        sdb.add(duplicate_photo)
        sdb.commit()
        
        return jsonify(ok=True, photo_id=new_photo_id, src=new_src)

@app.post('/api/photos/<photo_id>/share')
def api_share_photo(photo_id):
    """Generate shareable link for photo"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as sdb:
        photo = sdb.get(Photo, photo_id)
        if not photo:
            return jsonify(error='Photo not found'), 404
        
        # Generate share token
        share_token = secrets.token_urlsafe(32)
        
        # Create share link record (reusing ShareLink table)
        share_link = ShareLink(
            id=str(uuid.uuid4()),
            project_id=photo.project_id,
            token=share_token,
            expires_at=None,  # Never expires for photo shares
            created_at=datetime.now(timezone.utc)
        )
        
        sdb.add(share_link)
        sdb.commit()
        
        # Generate shareable URL
        base_url = request.url_root.rstrip('/')
        share_url = f"{base_url}/photo/{photo_id}/share/{share_token}"
        
        return jsonify(ok=True, share_url=share_url, token=share_token)

@app.get('/photo/<photo_id>/share/<token>')
def photo_share_public(photo_id, token):
    """Public access to shared photo"""
    with SessionLocal() as sdb:
        # Find the share link
        share_link = sdb.query(ShareLink).filter(
            ShareLink.token == token
        ).first()
        
        if not share_link:
            abort(404)
        
        # Check if expired
        if share_link.expires_at and share_link.expires_at < datetime.now(timezone.utc):
            abort(404)
        
        # Get the photo
        photo = sdb.get(Photo, photo_id)
        if not photo:
            abort(404)
        
        # Verify photo belongs to the shared project
        if photo.project_id != share_link.project_id:
            abort(404)
        
        # Get project info
        project = sdb.get(Project, photo.project_id)
        
        return render_template('photo_share.html', 
                             photo=photo, 
                             project=project,
                             share_token=token)

# --- Map API ---
@app.get('/map')
def map_view():
    """Map view page"""
    uid = session.get('uid')
    if not uid: abort(401)
    return render_template('map.html')

@app.get('/api/projects/map')
def api_projects_map():
    """Get projects with coordinates for map display"""
    uid = session.get('uid')
    if not uid: abort(401)
    
    with SessionLocal() as sdb:
        # Get projects user has access to
        if is_system_admin(uid):
            # Admin sees all projects
            projects = sdb.query(Project).all()
        else:
            # Regular users see only their projects
            user_project_ids = sdb.query(ProjectMember.project_id).filter(
                ProjectMember.user_id == uid
            ).subquery()
            projects = sdb.query(Project).filter(
                Project.id.in_(user_project_ids)
            ).all()
        
        print(f"🗺️ [DEBUG] Found {len(projects)} total projects for user {uid}")
        
        # Update coordinates for projects that don't have them
        updated_any = False
        for project in projects:
            print(f"🗺️ [DEBUG] Project: {project.name}")
            print(f"   Address: {project.address_line}, {project.city}, {project.state} {project.zip}")
            print(f"   Coordinates: {project.latitude}, {project.longitude}")
            
            if not project.latitude or not project.longitude:
                print(f"   → Trying to geocode...")
                update_project_coordinates(project)
                if project.latitude and project.longitude:
                    updated_any = True
                    print(f"   ✅ Got coordinates: {project.latitude}, {project.longitude}")
                else:
                    print(f"   ❌ Failed to get coordinates")
        
        if updated_any:
            sdb.commit()
        
        # Build response data
        map_projects = []
        projects_with_coords = 0
        for project in projects:
            if project.latitude and project.longitude:
                # Count photos
                photo_count = sdb.query(Photo).filter(Photo.project_id == project.id).count()
                
                # Get latest photo date
                latest_photo = sdb.query(Photo).filter(
                    Photo.project_id == project.id
                ).order_by(Photo.created_at.desc()).first()
                
                last_updated = latest_photo.created_at.strftime('%b %d, %Y') if latest_photo else 'No photos'
                
                # Build address string
                address_parts = []
                if project.address_line: address_parts.append(project.address_line)
                if project.city: address_parts.append(project.city)
                if project.state: address_parts.append(project.state)
                if project.zip: address_parts.append(project.zip)
                full_address = ', '.join(address_parts)
                
                map_projects.append({
                    'id': project.id,
                    'name': project.name,
                    'human_code': project.human_code,
                    'category': project.category or 'default',
                    'address': full_address,
                    'latitude': float(project.latitude),
                    'longitude': float(project.longitude),
                    'photo_count': photo_count,
                    'last_updated': last_updated,
                    'thumb': project.thumb
                })
                projects_with_coords += 1
        
        print(f"🗺️ [DEBUG] Returning {projects_with_coords} projects with coordinates out of {len(projects)} total")
        print(f"🗺️ [DEBUG] Projects being sent to map:")
        for proj in map_projects:
            print(f"   - {proj['name']} ({proj['human_code']}) at {proj['latitude']}, {proj['longitude']}")
        
        return jsonify({
            'projects': map_projects,
            'total_count': len(map_projects)
        })

# --- Export (ZIP + PDF) ---
def _normalize_name(s: str) -> str:
    s = s or 'file'; s = s.lower(); return re.sub(r'[^a-z0-9._-]+','-', s).strip('-') or 'file'
def _fetch_bytes(url_or_path: str) -> bytes:
    if url_or_path.startswith('/static/'):
        abspath = os.path.join(os.getcwd(), url_or_path.lstrip('/'))
        with open(abspath, 'rb') as f: return f.read()
    r = requests.get(url_or_path, timeout=20); r.raise_for_status(); return r.content

@app.route('/reports')
def reports_view():
    """DAR System - Damage Analysis Reports"""
    uid = session.get('uid')
    if not uid: return redirect(url_for('auth_login'))
    
    # Serve the DAR system
    try:
        with open('dar_form_template_complete.html', 'r', encoding='utf-8') as f:
            dar_html = f.read()
        return dar_html
    except FileNotFoundError:
        return "DAR System not found. Please ensure dar_form_template_complete.html exists.", 404

@app.route('/reports/simple')
def reports_simple():
    """Simple photo report MVP using PDFMake in a minimal template."""
    uid = session.get('uid')
    if not uid: return redirect(url_for('auth_login'))
    # Optional: accept a project_id query param to pre-fill selector
    proj_id = request.args.get('project_id', '')
    return render_template('report_simple.html', project_id=proj_id)

@app.get('/api/projects/<proj_id>/export/zip')
def export_zip(proj_id):
    with SessionLocal() as sdb:
        proj = sdb.get(Project, proj_id)
        if not proj: return jsonify(error='project not found'), 404
        # require viewer (member)
        uid = session.get('uid')
        if not uid: abort(401)
        if not user_role_for_project(sdb, proj_id, uid): abort(403)
        photos = sdb.query(Photo).filter(Photo.project_id==proj_id).order_by(Photo.created_at.desc()).all()
        mem = io.BytesIO()
        with zipfile.ZipFile(mem, 'w', zipfile.ZIP_DEFLATED) as z:
            for ph in photos:
                base = os.path.basename(ph.s3_key or ph.src)
                name, ext = os.path.splitext(base)
                ext = ext if ext.lower() in ('.jpg','.jpeg','.png','.webp','.gif','.heic','.heif') else '.jpg'
                safe = _normalize_name(f"{ph.date or ''}_{ph.author or ''}_{name}") + ext
                try: data = _fetch_bytes(ph.src)
                except Exception:
                    try: data = _fetch_bytes(ph.s3_key)
                    except Exception: continue
                z.writestr(safe, data)
        mem.seek(0)
        return send_file(mem, as_attachment=True, download_name=_normalize_name(f"{proj.name}_export.zip"), mimetype='application/zip')

@app.get('/api/projects/<proj_id>/export/pdf')
def export_pdf(proj_id):
    with SessionLocal() as sdb:
        proj = sdb.get(Project, proj_id)
        if not proj: return jsonify(error='project not found'), 404
        uid = session.get('uid')
        if not uid: abort(401)
        if not user_role_for_project(sdb, proj_id, uid): abort(403)
        photos = sdb.query(Photo).filter(Photo.project_id==proj_id).order_by(Photo.created_at.desc()).all()
        mem = io.BytesIO()
        c = canvas.Canvas(mem, pagesize=A4); W, H = A4
        margin = 36; img_box_w = W - margin*2; img_box_h = H - margin*2 - 120
        for idx, ph in enumerate(photos, start=1):
            c.setFillColorRGB(1,1,1); c.rect(0,0,W,H,fill=1,stroke=0)
            c.setFillColorRGB(0,0,0); c.setFont('Helvetica-Bold', 14)
            c.drawString(margin, H-margin, f"{proj.name} — Foto {idx}/{len(photos)}")
            try: data = _fetch_bytes(ph.src)
            except Exception:
                try: data = _fetch_bytes(ph.s3_key)
                except Exception:
                    c.setFont('Helvetica', 12); c.drawString(margin, H - margin - 24, "[No se pudo descargar la imagen]"); c.showPage(); continue
            try:
                im = Image.open(io.BytesIO(data)).convert('RGB')
                iw, ih = im.size; scale = min(img_box_w/iw, img_box_h/ih); tw, th = int(iw*scale), int(ih*scale)
                im = im.resize((tw, th)); buf = io.BytesIO(); im.save(buf, format='JPEG', quality=85); buf.seek(0)
                img = ImageReader(buf); x = margin + (img_box_w - tw)/2; y = margin + 120 + (img_box_h - th)/2
                c.drawImage(img, x, y, width=tw, height=th)
            except Exception:
                c.setFont('Helvetica', 12); c.drawString(margin, H - margin - 24, "[No se pudo procesar la imagen]"); c.showPage(); continue
            c.setFont('Helvetica', 11); meta_y = margin + 90
            c.drawString(margin, meta_y, f"Autor: {ph.author or '—'}")
            c.drawString(margin, meta_y - 16, f"Fecha: {ph.date or '—'}")
            c.drawString(margin, meta_y - 32, f"GPS: {ph.gps or '—'}")
            c.drawString(margin, meta_y - 48, f"Etiquetas: {ph.labels or '—'}")
            c.setFont('Helvetica', 9); c.drawRightString(W - margin, margin - 4, "PICKCAM · Export"); c.showPage()
        c.save(); mem.seek(0)
        return send_file(mem, as_attachment=True, download_name=_normalize_name(f"{proj.name}_export.pdf"), mimetype='application/pdf')

# --- Project Notes API ---
@app.get('/api/projects/<proj_id>/notes')
def api_get_notes(proj_id):
    """Return project notes as JSON or plain text (?format=text)."""
    uid = session.get('uid')
    if not uid: abort(401)
    with SessionLocal() as sdb:
        proj = sdb.get(Project, proj_id)
        if not proj: return jsonify(error='Project not found'), 404
        # Require at least viewer role
        if not user_role_for_project(sdb, proj_id, uid) and not is_system_admin(uid):
            abort(403)
    notes_path = _project_notes_path(proj_id)
    text = ''
    try:
        if os.path.exists(notes_path):
            with open(notes_path, 'r', encoding='utf-8') as f:
                text = f.read()
    except Exception:
        text = ''
    if request.args.get('format') == 'text':
        return app.response_class(text, mimetype='text/plain')
    return jsonify(ok=True, text=text)

@app.post('/api/projects/<proj_id>/notes')
def api_save_notes(proj_id):
    """Save or append to project notes. Accepts JSON {'text': str, 'mode': 'overwrite'|'append'}"""
    uid = session.get('uid')
    if not uid: abort(401)
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get('text') or '').rstrip()
    mode = (data.get('mode') or 'overwrite').lower()
    if mode not in ('overwrite','append'): mode = 'overwrite'
    with SessionLocal() as sdb:
        proj = sdb.get(Project, proj_id)
        if not proj: return jsonify(error='Project not found'), 404
        # Require contributor role to modify (system admins are allowed regardless of membership)
        role = user_role_for_project(sdb, proj_id, uid)
        if not (role in ('contributor','admin') or is_system_admin(uid)):
            abort(403)
    notes_path = _project_notes_path(proj_id)
    try:
        if mode == 'append' and os.path.exists(notes_path):
            with open(notes_path, 'a', encoding='utf-8') as f:
                if text:
                    f.write(('\n' if os.path.getsize(notes_path) > 0 else '') + text)
        else:
            with open(notes_path, 'w', encoding='utf-8') as f:
                f.write(text)
        return jsonify(ok=True)
    except Exception as e:
        return jsonify(error=str(e)), 500

@app.get('/api/projects/<proj_id>/notes/download')
def api_download_notes(proj_id):
    uid = session.get('uid')
    if not uid: abort(401)
    with SessionLocal() as sdb:
        proj = sdb.get(Project, proj_id)
        if not proj: return jsonify(error='Project not found'), 404
        if not user_role_for_project(sdb, proj_id, uid) and not is_system_admin(uid):
            abort(403)
    notes_path = _project_notes_path(proj_id)
    if not os.path.exists(notes_path):
        # Return empty file
        open(notes_path, 'a', encoding='utf-8').close()
    return send_file(notes_path, as_attachment=True, download_name=f'{proj_id}_notes.txt', mimetype='text/plain')

@app.post('/api/upload-file-to-monday')
def api_upload_file_to_monday():
    """Upload PDF file to Monday.com for DAR system"""
    uid = session.get('uid')
    if not uid: 
        return jsonify(error='Not authenticated'), 401
    
    try:
        # Get uploaded file and metadata
        if 'file' not in request.files:
            return jsonify(error='No file uploaded'), 400
            
        file = request.files['file']
        v_id = request.form.get('v_id', '').strip()
        project_id = request.form.get('project_id', '').strip()
        
        if not file or file.filename == '':
            return jsonify(error='No file selected'), 400
            
        if not v_id:
            return jsonify(error='V-ID is required'), 400
        
        print(f"📤 [MONDAY] Upload request - V-ID: {v_id}, Project: {project_id}")
        print(f"📤 [MONDAY] File: {file.filename}, Size: {file.content_length}")
        
        # For now, simulate Monday.com upload
        # In production, this would integrate with Monday.com API
        
        # Read file content for validation
        file_content = file.read()
        file.seek(0)  # Reset file pointer
        
        if len(file_content) < 1000:
            return jsonify(error=f'File too small ({len(file_content)} bytes), may be corrupted'), 400
        
        print(f"✅ [MONDAY] File validation passed - {len(file_content)} bytes")
        
        # TODO: Implement actual Monday.com API integration here
        # For now, return success simulation
        
        return jsonify({
            'success': True,
            'message': 'PDF uploaded successfully to Monday.com',
            'file_name': file.filename,
            'file_size': len(file_content),
            'v_id': v_id,
            'project_id': project_id,
            'upload_id': f'mock_upload_{v_id}_{int(time.time())}',
            'monday_url': f'https://monday.com/boards/mock/{v_id}'
        })
        
    except Exception as e:
        print(f"❌ [MONDAY] Upload error: {str(e)}")
        return jsonify(error=f'Upload failed: {str(e)}'), 500

@app.post('/api/reports/email')
def api_email_report():
    """Receive a PDF from frontend and email to recipients."""
    uid = session.get('uid')
    if not uid: return jsonify(error='Not authenticated'), 401
    try:
        if 'file' not in request.files:
            return jsonify(error='No file uploaded'), 400
        file = request.files['file']
        recipients_raw = request.form.get('recipients','').strip()
        subject = request.form.get('subject','PICK–CAM Report').strip() or 'PICK–CAM Report'
        recipients = [e.strip() for e in recipients_raw.split(',') if e.strip()]
        if not recipients:
            return jsonify(error='No recipients'), 400
        # Prepare email
        if not SMTP_USERNAME or not SMTP_PASSWORD:
            return jsonify(error='Email not configured on server'), 500
        msg = MIMEMultipart('mixed')
        msg['Subject'] = subject
        msg['From'] = f'{FROM_NAME} <{FROM_EMAIL}>'
        msg['To'] = ', '.join(recipients)
        body = MIMEMultipart('alternative')
        body.attach(MIMEText('Attached is your inspection report from PICK–CAM.', 'plain'))
        msg.attach(body)
        # Attach PDF
        pdf_bytes = file.read()
        from email.mime.application import MIMEApplication
        part = MIMEApplication(pdf_bytes, _subtype='pdf')
        part.add_header('Content-Disposition', 'attachment', filename=file.filename or 'report.pdf')
        msg.attach(part)
        # Send
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.starttls()
        server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.sendmail(FROM_EMAIL, recipients, msg.as_string())
        server.quit()
        return jsonify(success=True, sent=len(recipients))
    except Exception as e:
        return jsonify(error=str(e)), 500

if __name__ == "__main__":
    # Enable network access for mobile testing
    app.run(
        host='0.0.0.0',  # Listen on all network interfaces
        port=5000,       # Use port 5000
        debug=True,
        threaded=True    # Enable threading for better mobile performance
    )