// PICKCAM Camera Capture Module
// Auto orientation (no UI buttons needed) + voice & GPS preserved

class CameraCapture {
    constructor() {
        this.stream = null;
        this.video = null;
        this.canvas = null;
        this.isActive = false;
        this.capturedPhotos = [];
        this.projectId = null;

        // Voice recording integration (unchanged)
        this.voiceRecorder = null;
        this.isVoiceEnabled = true;
        this.currentVoiceTranscript = '';
        this.voiceStartTime = null;

        // Mobile dictation via keyboard mic (unchanged)
        this.isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
        this.useKeyboardDictation = this.isMobile;
        this.pendingDictation = '';
        this.keepDictation = false;

        // Preview controls
        this.manualRotationDeg = 0;                // still available for devs if needed
        this.fitMode = 'contain';                  // keep full frame
        this.rotationPreference = (typeof localStorage!== 'undefined' && localStorage.getItem('camRotatePref')) || 'cw';

        // Auto-orientation flags
        this.alwaysLandscape = true;               // final output must be landscape
        this._lastOrientationMode = null;
        this._orientationHandler = null;

        // Track for ImageCapture
        this._videoTrack = null;
    }

    // === Orientation helpers ===
    detectOrientation() {
        const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
            ? screen.orientation.angle
            : (typeof window.orientation === 'number' ? window.orientation : 0);
        switch ((angle + 360) % 360) {
            case 0:   return 'portrait';
            case 90:  return 'landscape-right';
            case 180: return 'portrait-upside';
            case 270: return 'landscape-left';
            default:  return 'portrait';
        }
    }

    applyVideoOrientationTransform() {
        if (!this.video) return;
        const mode = this.detectOrientation();
        this._lastOrientationMode = mode;

        // Preview: si el dispositivo est芍 en portrait, giramos 90～ para que la vista previa sea horizontal,
        // si est芍 en landscape, no giramos. Esto NO altera la imagen real, solo la previsualizaci車n.
        const base = mode.startsWith('landscape') ? 0 : 90;
        const deg = (base + this.manualRotationDeg) % 360;
        this.video.style.transform = `rotate(${deg}deg)`;
    }

    attachOrientationListeners() {
        const handler = () => this.applyVideoOrientationTransform();
        this._orientationHandler = handler;

        window.addEventListener('orientationchange', handler);
        if (screen.orientation && typeof screen.orientation.addEventListener === 'function') {
            screen.orientation.addEventListener('change', handler);
        }
        // Fallback adicional
        window.addEventListener('resize', handler);

        // MediaQuery fallback
        if (window.matchMedia) {
            const mq = window.matchMedia('(orientation: landscape)');
            if (typeof mq.addEventListener === 'function') {
                mq.addEventListener('change', handler);
            }
        }
    }

    detachOrientationListeners() {
        if (!this._orientationHandler) return;
        const handler = this._orientationHandler;

        window.removeEventListener('orientationchange', handler);
        if (screen.orientation && typeof screen.orientation.removeEventListener === 'function') {
            screen.orientation.removeEventListener('change', handler);
        }
        window.removeEventListener('resize', handler);
    }

    // Lee el 芍ngulo REAL aplicado al <video> en CSS para replicarlo en canvas
    getPreviewRotationDeg() {
        if (!this.video) return 0;
        const st = getComputedStyle(this.video);
        const tr = st.transform || 'none';
        if (tr === 'none') return 0;

        // matrix(a, b, c, d, e, f)
        const m2d = tr.match(/matrix\(([-0-9.,\s]+)\)/);
        if (m2d && m2d[1]) {
            const [a, b] = m2d[1].split(',').map(parseFloat);
            let deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
            if (deg < 0) deg += 360;
            return deg;
        }

        // matrix3d(...) -> aproximaci車n usando a,b como 2D
        const m3d = tr.match(/matrix3d\(([-0-9.,\s]+)\)/);
        if (m3d && m3d[1]) {
            const m = m3d[1].split(',').map(parseFloat);
            const a = m[0], b = m[1];
            let deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
            if (deg < 0) deg += 360;
            return deg;
        }

        return 0;
    }

    // === Camera lifecycle ===
    async startCamera(projectId) {
        this.projectId = projectId;

        try {
            console.log('?? [CAMERA] Starting camera for project:', projectId);

            const constraints = {
                video: {
                    facingMode: 'environment',
                    width:  { ideal: 1280, max: 1920 },
                    height: { ideal: 720,  max: 1080 }
                }
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            this._videoTrack = this.stream.getVideoTracks()[0];

            this.createCameraInterface();
            if (this.useKeyboardDictation) {
                this.injectDictationUI();
            } else {
                this.setupVoiceRecording();
            }
            this.isActive = true;

            // Orientaci車n inicial + listeners
            this.applyVideoOrientationTransform();
            this.attachOrientationListeners();

        } catch (error) {
            console.error('Camera access error:', error);

            let errorMessage = 'Camera access is required to take photos.';
            if (error.name === 'NotAllowedError') {
                errorMessage = 'Camera permission denied. Please allow access and try again.';
            } else if (error.name === 'NotFoundError') {
                errorMessage = 'No camera found on this device.';
            } else if (error.name === 'NotSupportedError') {
                errorMessage = 'Camera not supported in this browser. Use Chrome, Safari, or Edge.';
            } else if (error.name === 'NotReadableError') {
                errorMessage = 'Camera in use by another app. Close other apps and try again.';
            }
            this.showError(errorMessage);
        }
    }

    createCameraInterface() {
        const overlay = document.createElement('div');
        overlay.id = 'cameraOverlay';
        overlay.innerHTML = `
            <div class="camera-container">
                <div class="camera-header">
                    <button class="camera-btn close-btn" onclick="cameraCapture.closeCamera()" aria-label="Close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                    <div class="camera-title-section">
                        <h3>Take Photos</h3>
                        ${this.useKeyboardDictation ? '' : `
                        <div class="voice-status" id="voiceStatus">
                            <div class="voice-indicator" id="voiceIndicator"></div>
                            <span id="voiceText">Voice recording ready</span>
                        </div>`}
                    </div>
                    ${this.useKeyboardDictation ? `
                    <button class="camera-btn" id="dictateBtnTop" onclick="cameraCapture.showDictationSheet()" title="Dictate note">???</button>
                    ` : `
                    <button class="camera-btn voice-toggle-btn" onclick="cameraCapture.toggleVoiceRecording()" id="voiceToggleBtn" title="Toggle voice">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                            <line x1="8" y1="23" x2="16" y2="23"></line>
                        </svg>
                    </button>`}
                </div>

                <div class="camera-viewport">
                    <video id="cameraVideo" autoplay playsinline style="transform-origin:center center;"></video>
                    <div class="camera-overlay-grid">
                        <div class="grid-line"></div>
                        <div class="grid-line"></div>
                        <div class="grid-line"></div>
                        <div class="grid-line"></div>
                    </div>
                </div>

                <div class="camera-controls">
                    <div class="photos-count">
                        <span id="photosCount">${this.capturedPhotos.length}</span> photos
                    </div>

                    <button class="capture-btn" onclick="cameraCapture.capturePhoto()" title="Capture">
                        <div class="capture-inner"></div>
                    </button>

                    <button class="camera-btn gallery-btn" onclick="cameraCapture.showGallery()" ${this.capturedPhotos.length === 0 ? 'disabled' : ''} title="Gallery">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                            <circle cx="8.5" cy="8.5" r="1.5"></circle>
                            <polyline points="21,15 16,10 5,21"></polyline>
                        </svg>
                        <span class="badge" id="galleryBadge">${this.capturedPhotos.length}</span>
                    </button>
                </div>

                <div class="camera-footer">
                    <button class="btn secondary" onclick="cameraCapture.closeCamera()">Cancel</button>
                    <button class="btn primary" onclick="cameraCapture.uploadAll()" ${this.capturedPhotos.length === 0 ? 'disabled' : ''}>
                        Upload ${this.capturedPhotos.length} Photo${this.capturedPhotos.length !== 1 ? 's' : ''}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Bind video
        this.video = document.getElementById('cameraVideo');
        this.video.srcObject = this.stream;

        // Hidden canvas
        this.canvas = document.createElement('canvas');

        // Styles
        this.addCameraStyles();
    }

    addCameraStyles() {
        if (document.getElementById('cameraStyles')) return;

        const styles = document.createElement('style');
        styles.id = 'cameraStyles';
        styles.textContent = `
            #cameraOverlay { position: fixed; inset: 0; background:#000; z-index:9999; display:flex; flex-direction:column; }
            .camera-container { display:flex; flex-direction:column; height:100%; color:#fff; }
            .camera-header { display:flex; justify-content:space-between; align-items:center; padding:16px; background:rgba(0,0,0,.5); }
            .camera-title-section { flex:1; text-align:center; }
            .camera-title-section h3 { margin:0 0 4px 0; font-size:18px; font-weight:600; }
            .voice-status { display:flex; align-items:center; justify-content:center; gap:8px; font-size:12px; opacity:.8; }
            .voice-indicator { width:8px; height:8px; border-radius:50%; background:#10b981; transition:.3s; }
            .voice-indicator.recording { background:#ef4444; animation:pulse 1.5s infinite; }
            .voice-indicator.disabled { background:#6b7280; }
            @keyframes pulse { 0%,100%{opacity:1; transform:scale(1)} 50%{opacity:.5; transform:scale(1.2)} }
            .camera-btn { background:none; border:0; color:#fff; padding:8px; border-radius:50%; cursor:pointer; transition:background .2s; }
            .camera-btn:hover { background:rgba(255,255,255,.2); }
            .camera-viewport { flex:1; position:relative; overflow:hidden; background:#000; }
            #cameraVideo { width:100%; height:100%; object-fit:contain; background:#000; transform-origin:center center; }
            .camera-overlay-grid { position:absolute; inset:0; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; pointer-events:none; }
            .grid-line { border:1px solid rgba(255,255,255,.3); border-width:0 1px 1px 0; }
            .grid-line:nth-child(2n){ border-right:none; } .grid-line:nth-child(n+3){ border-bottom:none; }
            .camera-controls { display:flex; justify-content:space-between; align-items:center; padding:24px; background:rgba(0,0,0,.5); }
            .photos-count { font-size:14px; opacity:.8; min-width:60px; }
            .capture-btn { width:80px; height:80px; border:4px solid #fff; border-radius:50%; background:none; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:.2s; }
            .capture-btn:hover{ transform:scale(1.05); } .capture-btn:active{ transform:scale(.95); }
            .capture-inner{ width:60px; height:60px; background:#fff; border-radius:50%; transition:.1s; }
            .capture-btn:active .capture-inner{ transform:scale(.8); }
            .gallery-btn{ position:relative; min-width:60px; text-align:center; }
            .gallery-btn:disabled{ opacity:.5; cursor:not-allowed; }
            .badge{ position:absolute; top:-4px; right:-4px; background:#f97316; color:#fff; border-radius:10px; padding:2px 6px; font-size:12px; min-width:16px; display:none; }
            .camera-footer{ display:flex; justify-content:space-between; padding:16px; background:rgba(0,0,0,.5); }
            .camera-footer .btn{ padding:12px 24px; border-radius:8px; border:0; font-weight:600; cursor:pointer; transition:.2s; }
            .camera-footer .btn.secondary{ background:rgba(255,255,255,.2); color:#fff; }
            .camera-footer .btn.primary{ background:#f97316; color:#fff; }
            .camera-footer .btn:disabled{ opacity:.5; cursor:not-allowed; }
            .camera-footer .btn:hover:not(:disabled){ transform:translateY(-1px); }
            @media (max-width:768px){
                .camera-header{ padding:12px 16px; }
                .camera-controls{ padding:20px 16px; gap:8px; }
                .capture-btn{ width:70px; height:70px; }
                .capture-inner{ width:50px; height:50px; }
                .camera-footer{ padding:12px 16px; }
                .photos-count{ font-size:16px; }
            }
        `;
        document.head.appendChild(styles);
    }

    injectDictationUI() {
        const sheet = document.createElement('div');
        sheet.id = 'dictationSheet';
        sheet.innerHTML = `
            <div class="row" style="position:relative;">
                <span id="dictationBadge">Saved</span>
                <textarea id="dictationInput" placeholder="Dictate a note for this photo＃"></textarea>
            </div>
            <div id="dictationActions">
                <label style="display:flex; align-items:center; gap:6px; font-size:12px; opacity:.9;">
                    <input id="keepDictationChk" type="checkbox" ${this.keepDictation? 'checked':''}>
                    Keep note for next photo
                </label>
                <div style="display:flex; gap:8px;">
                    <button class="btn secondary" onclick="cameraCapture.hideDictationSheet()">Close</button>
                    <button class="btn primary" onclick="cameraCapture.saveDictation()">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(sheet);
    }

    showDictationSheet(){const s=document.getElementById('dictationSheet'); if(!s) return; s.style.display='block'; const ta=document.getElementById('dictationInput'); if(ta){ ta.value=this.pendingDictation||''; setTimeout(()=>{ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); },0);} }
    hideDictationSheet(){const s=document.getElementById('dictationSheet'); if(s) s.style.display='none';}
    saveDictation(){const ta=document.getElementById('dictationInput'); const badge=document.getElementById('dictationBadge'); const keep=document.getElementById('keepDictationChk'); this.pendingDictation=(ta&&ta.value||'').trim(); this.keepDictation=!!(keep&&keep.checked); if(badge){ badge.style.display=this.pendingDictation?'inline-block':'none'; setTimeout(()=>{ if(badge) badge.style.display='none'; },1200);} this.hideDictationSheet(); }

    getCurrentLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
            navigator.geolocation.getCurrentPosition(
                pos => resolve(pos),
                err => reject(err),
                { enableHighAccuracy:true, timeout:10000, maximumAge:300000 }
            );
        });
    }

    // === Capture ===
    async capturePhoto() {
        if (!this.video || !this.stream) return;

        this.showFlashEffect();

        // Prefer ImageCapture when available: respeta EXIF/orientaci車n y evita fotos al rev谷s
        const track = this._videoTrack;
        if (track && 'ImageCapture' in window) {
            try {
                const ic = new ImageCapture(track);
                const blob = await ic.takePhoto(); // foto con metadatos del sensor
                const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });

                // Dibujamos el bitmap ya orientado correctamente
                this.canvas.width = bitmap.width;
                this.canvas.height = bitmap.height;
                const ctx = this.canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0);

                // Garantiza paisaje final si se pidi車
                if (this.alwaysLandscape && this.canvas.height > this.canvas.width) {
                    const rotated = this.rotateCanvas90(this.canvas, (this.rotationPreference === 'cw') ? 90 : -90);
                    this.canvas = rotated;
                }

                await this.finalizeCapture();
                return;
            } catch (err) {
                console.warn('ImageCapture failed, falling back to video frame:', err);
            }
        }

        // Fallback: replicar EXACTAMENTE la rotaci車n de la vista previa
        const srcW = this.video.videoWidth;
        const srcH = this.video.videoHeight;
        const deg = this.getPreviewRotationDeg(); // lo que ve el usuario

        const ctx = this.canvas.getContext('2d');

        // Configuramos tama?o del canvas seg迆n rotaci車n
        const rotate90 = deg === 90 || deg === 270;
        this.canvas.width  = rotate90 ? srcH : srcW;
        this.canvas.height = rotate90 ? srcW : srcH;

        ctx.save();
        // Traslados y rotaciones equivalentes al preview
        if (deg === 90) {
            ctx.translate(this.canvas.width, 0);
            ctx.rotate(Math.PI/2);
        } else if (deg === 180) {
            ctx.translate(this.canvas.width, this.canvas.height);
            ctx.rotate(Math.PI);
        } else if (deg === 270) {
            ctx.translate(0, this.canvas.height);
            ctx.rotate(-Math.PI/2);
        }
        ctx.drawImage(this.video, 0, 0, srcW, srcH);
        ctx.restore();

        // Asegura paisaje final (si por cualquier raz車n qued車 vertical)
        if (this.alwaysLandscape && this.canvas.height > this.canvas.width) {
            const rotated = this.rotateCanvas90(this.canvas, (this.rotationPreference === 'cw') ? 90 : -90);
            this.canvas = rotated;
        }

        await this.finalizeCapture();
    }

    // Rota un canvas 90～ CW/CCW y devuelve un nuevo canvas
    rotateCanvas90(sourceCanvas, angleDeg = 90) {
        const out = document.createElement('canvas');
        const ctx = out.getContext('2d');
        const cw = sourceCanvas.width, ch = sourceCanvas.height;

        if (angleDeg === 90 || angleDeg === -270) {
            out.width = ch; out.height = cw;
            ctx.translate(out.width, 0);
            ctx.rotate(Math.PI / 2);
        } else if (angleDeg === -90 || angleDeg === 270) {
            out.width = ch; out.height = cw;
            ctx.translate(0, out.height);
            ctx.rotate(-Math.PI / 2);
        } else if (angleDeg === 180 || angleDeg === -180) {
            out.width = cw; out.height = ch;
            ctx.translate(out.width, out.height);
            ctx.rotate(Math.PI);
        } else {
            out.width = cw; out.height = ch;
        }
        ctx.drawImage(sourceCanvas, 0, 0);
        return out;
    }

    async finalizeCapture() {
        // GPS (opcional)
        let gpsData = '';
        try {
            const position = await this.getCurrentLocation();
            if (position) gpsData = `${position.coords.latitude.toFixed(6)},${position.coords.longitude.toFixed(6)}`;
        } catch (_) {}

        // Blob + meta
        const blob = await new Promise(res => this.canvas.toBlob(res, 'image/jpeg', 0.8));
        const dataUrl = this.canvas.toDataURL('image/jpeg', 0.8);

        let voiceComment = '';
        let voiceConfidence = 0;
        if (this.useKeyboardDictation) {
            voiceComment = (this.pendingDictation || '').trim();
            voiceConfidence = voiceComment ? 0.9 : 0;
            if (!this.keepDictation) this.pendingDictation = '';
        } else {
            voiceComment = this.voiceRecorder && this.isVoiceEnabled ? this.voiceRecorder.getFinalTranscript() : '';
            voiceConfidence = this.voiceRecorder ? this.voiceRecorder.getConfidence() : 0;
        }

        const photoData = {
            id: Date.now(),
            blob,
            dataUrl,
            timestamp: new Date(),
            voiceComment: voiceComment.trim(),
            voiceConfidence,
            gps: gpsData
        };

        this.capturedPhotos.push(photoData);
        this.updateUI();

        if (voiceComment.trim()) {
            console.log('??? [CAMERA] Photo with note:', voiceComment);
        }

        // Reinicia escucha de voz si aplica
        if (!this.useKeyboardDictation && this.voiceRecorder && this.isVoiceEnabled) {
            this.currentVoiceTranscript = '';
            setTimeout(() => {
                if (this.isActive && this.isVoiceEnabled) {
                    this.voiceRecorder.stop();
                    setTimeout(() => this.startVoiceRecording(), 500);
                }
            }, 100);
        }
    }

    showFlashEffect() {
        const flash = document.createElement('div');
        flash.style.cssText = `
            position: fixed; inset: 0; background: white;
            z-index: 10000; opacity: .8; pointer-events: none;
        `;
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 100);
    }

    updateUI() {
        const countEl = document.getElementById('photosCount');
        const badgeEl = document.getElementById('galleryBadge');
        const galleryBtn = document.querySelector('.gallery-btn');
        const uploadBtn = document.querySelector('.camera-footer .btn.primary');

        if (countEl) countEl.textContent = this.capturedPhotos.length;
        if (badgeEl) {
            badgeEl.textContent = this.capturedPhotos.length;
            badgeEl.style.display = this.capturedPhotos.length > 0 ? 'block' : 'none';
        }
        if (galleryBtn) galleryBtn.disabled = this.capturedPhotos.length === 0;
        if (uploadBtn) {
            uploadBtn.disabled = this.capturedPhotos.length === 0;
            uploadBtn.textContent = `Upload ${this.capturedPhotos.length} Photo${this.capturedPhotos.length !== 1 ? 's' : ''}`;
        }
    }

    async switchCamera() {
        if (!this.stream) return;

        try {
            this.stream.getTracks().forEach(t => t.stop());

            const cur = this._videoTrack && this._videoTrack.getSettings
                ? this._videoTrack.getSettings().facingMode
                : 'environment';
            const newFacingMode = cur === 'environment' ? 'user' : 'environment';

            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: newFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }
            });
            this._videoTrack = this.stream.getVideoTracks()[0];
            this.video.srcObject = this.stream;

            // Reaplica orientaci車n
            this.applyVideoOrientationTransform();

        } catch (error) {
            console.error('Failed to switch camera:', error);
        }
    }

    showGallery() {
        alert(`You have captured ${this.capturedPhotos.length} photos. Gallery view coming soon!`);
    }

    async uploadAll() {
        if (this.capturedPhotos.length === 0) return;

        showProgress(`Uploading ${this.capturedPhotos.length} photo${this.capturedPhotos.length !== 1 ? 's' : ''}...`);

        let ok = 0, fail = 0;

        for (let i = 0; i < this.capturedPhotos.length; i++) {
            const photo = this.capturedPhotos[i];
            const progress = Math.round(((i + 1) / this.capturedPhotos.length) * 100);
            try {
                showProgress(`Uploading photo ${i + 1}/${this.capturedPhotos.length}...`);
                setProgress(progress);
                await this.uploadSinglePhoto(photo);
                ok++;
            } catch (e) {
                console.error(`Failed to upload photo ${i + 1}:`, e);
                fail++;
            }
        }

        hideProgress();

        if (ok > 0) {
            alert(fail > 0
                ? `Upload completed! ${ok} uploaded, ${fail} failed.`
                : `All ${ok} photos uploaded successfully!`);
            this.closeCamera();
            location.reload();
        } else {
            alert('All uploads failed. Please try again.');
        }
    }

    async uploadSinglePhoto(photo) {
        const formData = new FormData();
        formData.append('project_id', this.projectId);
        formData.append('file', photo.blob, `camera_photo_${photo.id}.jpg`);

        if (photo.voiceComment && photo.voiceComment.trim()) {
            formData.append('voice_comment', photo.voiceComment);
            formData.append('voice_confidence', photo.voiceConfidence || 0);
        }
        if (photo.gps && photo.gps.trim()) {
            formData.append('gps', photo.gps);
        }
        formData.append('timestamp', photo.timestamp.toISOString());

        const response = await fetch('/api/photos/local_upload', { method: 'POST', body: formData });
        if (!response.ok) throw new Error(`Upload failed: ${response.statusText}`);

        const result = await response.json();
        if (!result.ok) throw new Error(result.error || 'Upload failed');
    }

    closeCamera() {
        if (this.voiceRecorder && this.isVoiceEnabled) this.voiceRecorder.stop();
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());

        this.detachOrientationListeners();

        const overlay = document.getElementById('cameraOverlay');
        if (overlay) overlay.remove();

        this.isActive = false;
        this.stream = null;
        this.video = null;
        this.canvas = null;
        this.capturedPhotos = [];

        this.voiceRecorder = null;
        this.isVoiceEnabled = true;
        this.currentVoiceTranscript = '';
        this.voiceStartTime = null;
    }

    showError(message) { alert(message); }

    // Voice Recording (unchanged except for minor guards)
    setupVoiceRecording() {
        console.log('??? [CAMERA] Setting up voice recording...');
        const wait = () => {
            if (window.getVoiceRecorder && window.getVoiceRecorder()) {
                this.voiceRecorder = window.getVoiceRecorder();
                this.initializeVoiceRecording();
            } else {
                setTimeout(wait, 100);
            }
        };
        wait();
    }

    initializeVoiceRecording() {
        if (!this.voiceRecorder || !this.voiceRecorder.isBrowserSupported()) {
            console.warn('?? [CAMERA] Voice recording not supported');
            this.isVoiceEnabled = false;
            this.updateVoiceUI();
            return;
        }
        this.voiceRecorder.onStart = () => { this.voiceStartTime = Date.now(); this.updateVoiceUI(); };
        this.voiceRecorder.onEnd   = () => { this.updateVoiceUI(); };
        this.voiceRecorder.onResult= (r) => { this.currentVoiceTranscript = r.final || r.interim || ''; this.updateVoiceTranscript(); };
        this.voiceRecorder.onError = (e) => { console.error('? [CAMERA] Voice error:', e); this.isVoiceEnabled = false; this.updateVoiceUI(); };

        if (this.isVoiceEnabled) this.startVoiceRecording();
    }

    startVoiceRecording() {
        if (!this.voiceRecorder || !this.isVoiceEnabled) return;
        const started = this.voiceRecorder.start();
        if (!started) this.isVoiceEnabled = false;
        this.updateVoiceUI();
    }

    stopVoiceRecording() {
        if (!this.voiceRecorder) return;
        this.voiceRecorder.stop();
        this.updateVoiceUI();
    }

    toggleVoiceRecording() {
        if (!this.voiceRecorder || !this.voiceRecorder.isBrowserSupported()) {
            alert('Voice recording is not supported in this browser. Please use Chrome, Safari, or Edge.');
            return;
        }
        this.isVoiceEnabled = !this.isVoiceEnabled;
        if (this.isVoiceEnabled) this.startVoiceRecording(); else this.stopVoiceRecording();
        this.updateVoiceUI();
    }

    updateVoiceUI() {
        const indicator = document.getElementById('voiceIndicator');
        const text = document.getElementById('voiceText');
        const toggleBtn = document.getElementById('voiceToggleBtn');
        if (!indicator || !text || !toggleBtn) return;

        if (!this.voiceRecorder || !this.voiceRecorder.isBrowserSupported()) {
            indicator.className = 'voice-indicator disabled';
            text.textContent = 'Voice not supported';
            toggleBtn.className = 'camera-btn voice-toggle-btn disabled';
            toggleBtn.disabled = true;
            return;
        }

        if (!this.isVoiceEnabled) {
            indicator.className = 'voice-indicator disabled';
            text.textContent = 'Voice recording disabled';
            toggleBtn.className = 'camera-btn voice-toggle-btn';
            toggleBtn.disabled = false;
        } else if (this.voiceRecorder.isRecordingActive()) {
            indicator.className = 'voice-indicator recording';
            text.textContent = 'Listening...';
            toggleBtn.className = 'camera-btn voice-toggle-btn active';
            toggleBtn.disabled = false;
        } else {
            indicator.className = 'voice-indicator';
            text.textContent = 'Voice recording ready';
            toggleBtn.className = 'camera-btn voice-toggle-btn';
            toggleBtn.disabled = false;
        }
    }

    updateVoiceTranscript() {
        const text = document.getElementById('voiceText');
        if (!text || !this.currentVoiceTranscript) return;
        if (this.voiceRecorder && this.voiceRecorder.isRecordingActive() && this.currentVoiceTranscript.length > 0) {
            const trunc = this.currentVoiceTranscript.length > 50 ? this.currentVoiceTranscript.substring(0, 50) + '...' : this.currentVoiceTranscript;
            text.textContent = `"${trunc}"`;
        }
    }

    // Preview utilities (manual rotation kept for devs)
    rotatePreview() {
        this.manualRotationDeg = (this.manualRotationDeg + 90) % 360;
        this.applyVideoOrientationTransform();
    }
    toggleFit() {
        this.fitMode = this.fitMode === 'contain' ? 'cover' : 'contain';
        const v = this.video; if (!v) return;
        v.style.objectFit = this.fitMode;
        const btn = document.getElementById('fitBtn');
        if (btn) btn.textContent = this.fitMode === 'contain' ? 'Fit' : 'Fill';
    }
    async fullscreen() {
        const el = document.getElementById('cameraOverlay');
        if (el && el.requestFullscreen) { try { await el.requestFullscreen(); } catch(e){} }
    }
    toggleRotationPref() {
        this.rotationPreference = this.rotationPreference === 'cw' ? 'ccw' : 'cw';
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('camRotatePref', this.rotationPreference); } catch(e){}
        const b = document.getElementById('fixDirBtn'); if (b) b.textContent = this.rotationPreference === 'cw' ? 'Fix CW' : 'Fix CCW';
    }
}

// Global camera instance
let cameraCapture = null;

async function startCameraCapture(projectId) {
    if (cameraCapture && cameraCapture.isActive) cameraCapture.closeCamera();
    cameraCapture = new CameraCapture();
    await cameraCapture.startCamera(projectId);
}

// HTTPS / localhost check
function isCameraSupported() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    const isSecure = location.protocol === 'https:' ||
                     location.hostname === 'localhost' ||
                     location.hostname === '127.0.0.1' ||
                     location.hostname.startsWith('192.168.') ||
                     location.hostname.startsWith('10.') ||
                     location.hostname.startsWith('172.');
    console.log('?? [CAMERA] Security check:', { protocol: location.protocol, hostname: location.hostname, isSecure });
    return isSecure;
}
