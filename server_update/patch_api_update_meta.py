# --- Add to your Flask app (from the upgrade pack) ---
# New endpoint to receive metadata from Lambda and switch photo src to derivative

import os
from flask import request, jsonify
from sqlalchemy import select

WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET', 'CHANGE_ME')
AWS_REGION = os.getenv('AWS_REGION', 'us-east-1')
DERIV_BUCKET = os.getenv('S3_BUCKET_DERIVATIVES', os.getenv('DERIVATIVES_BUCKET', 'pickcam-photos-deriv-dev'))
CDN_DERIV = os.getenv('CDN_DOMAIN_DERIVATIVES', '')

@app.post('/api/photos/update_meta')
def api_update_meta():
    secret = request.headers.get('X-Webhook-Secret')
    if secret != WEBHOOK_SECRET:
        return jsonify(error='unauthorized'), 401

    data = request.get_json(force=True)
    s3_key_original = data.get('s3_key_original')
    s3_key_web = data.get('s3_key_web')
    s3_key_thumb = data.get('s3_key_thumb')
    taken_at = data.get('taken_at')
    gps_lat = data.get('gps_lat')
    gps_lng = data.get('gps_lng')
    width = data.get('width')
    height = data.get('height')

    if not s3_key_original:
        return jsonify(error='missing s3_key_original'), 400

    # Build web URL for derivative
    if CDN_DERIV:
        web_url = f"https://{CDN_DERIV}/{s3_key_web}"
    else:
        web_url = f"https://{DERIV_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{s3_key_web}"

    with SessionLocal() as s:
        photo = s.execute(select(Photo).where(Photo.s3_key == s3_key_original)).scalar_one_or_none()
        if not photo:
            return jsonify(error='photo not found'), 404
        # Update fields
        photo.src = web_url
        # Store GPS/date in existing fields (or extend your model)
        if gps_lat is not None and gps_lng is not None:
            photo.gps = f"{gps_lat},{gps_lng}"
        if taken_at:
            photo.date = taken_at[:10]  # display YYYY-MM-DD in UI
        s.commit()
        return jsonify(ok=True)