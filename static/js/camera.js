// PICKCAM Camera Capture Module
// Inspired by CompanyCam's user experience

class CameraCapture {
    constructor() {
        this.stream = null;
        this.video = null;
        this.canvas = null;
        this.isActive = false;
        this.capturedPhotos = [];
        this.projectId = null;
        
        // Voice recording integration
        this.voiceRecorder = null;
        this.isVoiceEnabled = true;
        this.currentVoiceTranscript = '';
        this.voiceStartTime = null;

        // Mobile dictation via keyboard mic
        this.isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
        this.useKeyboardDictation = this.isMobile; // prefer OS keyboard dictation on mobile
        this.pendingDictation = '';
        this.keepDictation = false;

        // Preview controls
        this.manualRotationDeg = 0; // 0/90/180/270
        this.fitMode = 'contain'; // 'contain' or 'cover'
        this.rotationPreference = (typeof localStorage!== 'undefined' && localStorage.getItem('camRotatePref')) || 'cw'; // 'cw' or 'ccw'
    }

    async startCamera(projectId) {
        this.projectId = projectId;
        
        try {
            console.log('🎯 [CAMERA] Starting camera for project:', projectId);
            console.log('🌐 [CAMERA] Current context:', {
                protocol: location.protocol,
                hostname: location.hostname,
                userAgent: navigator.userAgent.substring(0, 100)
            });
            
            // More permissive camera constraints for mobile compatibility
            const constraints = { 
                video: { 
                    facingMode: 'environment', // Use back camera on mobile
                    width: { ideal: 1280, max: 1920 },
                    height: { ideal: 720, max: 1080 }
                } 
            };
            
            console.log('📷 [CAMERA] Requesting camera permissions with constraints:', constraints);
            
            // Request camera permissions
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            this.createCameraInterface();
            if (this.useKeyboardDictation) {
                this.injectDictationUI();
            } else {
                this.setupVoiceRecording();
            }
            this.isActive = true;
            
        } catch (error) {
            console.error('Camera access denied:', error);
            
            // More specific error handling for mobile
            let errorMessage = 'Camera access is required to take photos.';
            
            if (error.name === 'NotAllowedError') {
                errorMessage = 'Camera permission denied. Please:\n\n1. Allow camera access when prompted\n2. Check browser settings if needed\n3. Refresh the page and try again';
            } else if (error.name === 'NotFoundError') {
                errorMessage = 'No camera found on this device.';
            } else if (error.name === 'NotSupportedError') {
                errorMessage = 'Camera not supported in this browser. Please use Chrome, Safari, or Edge.';
            } else if (error.name === 'NotReadableError') {
                errorMessage = 'Camera is being used by another app. Please close other camera apps and try again.';
            }
            
            this.showError(errorMessage);
        }
    }

    createCameraInterface() {
        // Create camera overlay
        const overlay = document.createElement('div');
        overlay.id = 'cameraOverlay';
        overlay.innerHTML = `
            <div class="camera-container">
                <div class="camera-header">
                    <button class="camera-btn close-btn" onclick="cameraCapture.closeCamera()">
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
                    <button class="camera-btn" id="dictateBtnTop" onclick="cameraCapture.showDictationSheet()" title="Dictate note">🗣️</button>
                    ` : `
                    <button class="camera-btn voice-toggle-btn" onclick="cameraCapture.toggleVoiceRecording()" id="voiceToggleBtn">
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
                    
                    <button class="capture-btn" onclick="cameraCapture.capturePhoto()">
                        <div class="capture-inner"></div>
                    </button>
                    
                    <button class="camera-btn gallery-btn" onclick="cameraCapture.showGallery()" ${this.capturedPhotos.length === 0 ? 'disabled' : ''}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                            <circle cx="8.5" cy="8.5" r="1.5"></circle>
                            <polyline points="21,15 16,10 5,21"></polyline>
                        </svg>
                        <span class="badge" id="galleryBadge">${this.capturedPhotos.length}</span>
                    </button>

                    <div class="camera-tools">
                      <button class="tool-btn" title="Rotate" onclick="cameraCapture.rotatePreview()">↻</button>
                      <button class="tool-btn" id="fitBtn" title="Toggle Fit/Fill" onclick="cameraCapture.toggleFit()">Fill</button>
                      <button class="tool-btn" id="fixDirBtn" title="Fix direction for this device" onclick="cameraCapture.toggleRotationPref()">Fix CW</button>
                      <button class="tool-btn" title="Fullscreen" onclick="cameraCapture.fullscreen()">⛶</button>
                    </div>
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
        
        // Setup video stream
        this.video = document.getElementById('cameraVideo');
        this.video.srcObject = this.stream;
        
        // Create hidden canvas for capture
        this.canvas = document.createElement('canvas');
        
        // Add styles
        this.addCameraStyles();
    }

    addCameraStyles() {
        if (document.getElementById('cameraStyles')) return;
        
        const styles = document.createElement('style');
        styles.id = 'cameraStyles';
        styles.textContent = `
            #cameraOverlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: #000;
                z-index: 9999;
                display: flex;
                flex-direction: column;
            }
            
            .camera-container {
                display: flex;
                flex-direction: column;
                height: 100%;
                color: white;
            }
            
            .camera-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px;
                background: rgba(0,0,0,0.5);
            }
            
            .camera-title-section {
                flex: 1;
                text-align: center;
            }
            
            .camera-title-section h3 {
                margin: 0 0 4px 0;
                font-size: 18px;
                font-weight: 600;
            }
            
            .voice-status {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                font-size: 12px;
                opacity: 0.8;
            }
            
            .voice-indicator {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #10b981;
                transition: all 0.3s ease;
            }
            
            .voice-indicator.recording {
                background: #ef4444;
                animation: pulse 1.5s infinite;
            }
            
            .voice-indicator.disabled {
                background: #6b7280;
            }
            
            @keyframes pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.5; transform: scale(1.2); }
            }
            
            .voice-toggle-btn {
                position: relative;
            }
            
            .voice-toggle-btn.active {
                background: rgba(239, 68, 68, 0.2);
                color: #ef4444;
            }
            
            .voice-toggle-btn.disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .camera-btn {
                background: none;
                border: none;
                color: white;
                padding: 8px;
                border-radius: 50%;
                cursor: pointer;
                transition: background 0.2s;
            }
            
            .camera-btn:hover {
                background: rgba(255,255,255,0.2);
            }
            
            .camera-viewport {
                flex: 1;
                position: relative;
                overflow: hidden;
            }
            
            #cameraVideo {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            
            .camera-overlay-grid {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                display: grid;
                grid-template-columns: 1fr 1fr;
                grid-template-rows: 1fr 1fr;
                pointer-events: none;
            }
            
            .grid-line {
                border: 1px solid rgba(255,255,255,0.3);
                border-width: 0 1px 1px 0;
            }
            
            .grid-line:nth-child(2n) {
                border-right: none;
            }
            
            .grid-line:nth-child(n+3) {
                border-bottom: none;
            }
            
            .camera-controls {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 24px;
                background: rgba(0,0,0,0.5);
            }
            
            .photos-count {
                font-size: 14px;
                opacity: 0.8;
                min-width: 60px;
            }
            
            .capture-btn {
                width: 80px;
                height: 80px;
                border: 4px solid white;
                border-radius: 50%;
                background: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
            }
            
            .capture-btn:hover {
                transform: scale(1.05);
            }
            
            .capture-btn:active {
                transform: scale(0.95);
            }
            
            .capture-inner {
                width: 60px;
                height: 60px;
                background: white;
                border-radius: 50%;
                transition: all 0.1s;
            }
            
            .capture-btn:active .capture-inner {
                transform: scale(0.8);
            }
            
            .gallery-btn {
                position: relative;
                min-width: 60px;
                text-align: center;
            }
            
            .gallery-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .badge {
                position: absolute;
                top: -4px;
                right: -4px;
                background: #f97316;
                color: white;
                border-radius: 10px;
                padding: 2px 6px;
                font-size: 12px;
                min-width: 16px;
                display: ${this.capturedPhotos.length > 0 ? 'block' : 'none'};
            }
            
            .camera-footer {
                display: flex;
                justify-content: space-between;
                padding: 16px;
                background: rgba(0,0,0,0.5);
            }

            .camera-tools { display:flex; gap:10px; align-items:center; margin-left:8px; }
            .tool-btn { background:#111; color:#fff; border:1px solid #333; border-radius:10px; padding:10px 12px; font-size:14px; }
            @media (max-width: 768px) { .tool-btn { padding:12px 14px; font-size:16px; } }
            
            .camera-footer .btn {
                padding: 12px 24px;
                border-radius: 8px;
                border: none;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }
            
            .camera-footer .btn.secondary {
                background: rgba(255,255,255,0.2);
                color: white;
            }
            
            .camera-footer .btn.primary {
                background: #f97316;
                color: white;
            }
            
            .camera-footer .btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .camera-footer .btn:hover:not(:disabled) {
                transform: translateY(-1px);
            }
            
            /* Dictation drawer */
            #dictationSheet {
                position: fixed;
                left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.85);
                color: #fff;
                padding: 12px 12px 16px;
                z-index: 10000;
                display: none;
            }
            #dictationSheet .row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
            #dictationInput { width: 100%; min-height: 40px; border-radius: 8px; border: 1px solid #444; padding: 10px; background:#0b0b0b; color:#fff; }
            #dictationActions { display:flex; justify-content: space-between; align-items:center; margin-top:8px; }
            #dictationBadge { position:absolute; top: -6px; left: -6px; background:#f97316; color:#fff; border-radius:10px; font-size:10px; padding:2px 6px; display:none; }

            @media (max-width: 768px) {
                .camera-header {
                    padding: 12px 16px;
                }
                
                .camera-controls {
                    padding: 20px 16px;
                    gap: 8px;
                }
                
                .capture-btn {
                    width: 70px;
                    height: 70px;
                }
                
                .capture-inner {
                    width: 50px;
                    height: 50px;
                }
                
                .camera-footer {
                    padding: 12px 16px;
                }
                .photos-count { font-size: 16px; }
                .camera-tools { gap: 12px; }
                .tool-btn { padding: 12px 16px; font-size: 16px; }
            }
        `;
        
        document.head.appendChild(styles);
    }

    injectDictationUI() {
        // Create bottom sheet for dictation
        const sheet = document.createElement('div');
        sheet.id = 'dictationSheet';
        sheet.innerHTML = `
            <div class="row" style="position:relative;">
                <span id="dictationBadge">Saved</span>
                <textarea id="dictationInput" placeholder="Dictate a note for this photo…"></textarea>
            </div>
            <div id="dictationActions">
                <label style="display:flex; align-items:center; gap:6px; font-size:12px; opacity:0.9;">
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

    showDictationSheet() { const s=document.getElementById('dictationSheet'); if(!s) return; s.style.display='block'; const ta=document.getElementById('dictationInput'); if(ta){ ta.value=this.pendingDictation||''; setTimeout(()=>{ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);} }
    hideDictationSheet() { const s=document.getElementById('dictationSheet'); if(s) s.style.display='none'; }
    saveDictation() { const ta=document.getElementById('dictationInput'); const badge=document.getElementById('dictationBadge'); const keep=document.getElementById('keepDictationChk'); this.pendingDictation = (ta&&ta.value||'').trim(); this.keepDictation = !!(keep&&keep.checked); if(badge){ badge.style.display = this.pendingDictation? 'inline-block':'none'; setTimeout(()=>{ if(badge) badge.style.display='none'; }, 1200);} this.hideDictationSheet(); }

    getCurrentLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Geolocation not supported'));
                return;
            }
            
            navigator.geolocation.getCurrentPosition(
                position => resolve(position),
                error => reject(error),
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 300000 // 5 minutes
                }
            );
        });
    }

    async capturePhoto() {
        if (!this.video || !this.stream) return;
        
        // Flash effect
        this.showFlashEffect();
        
        // Capture frame
        const srcW = this.video.videoWidth;
        const srcH = this.video.videoHeight;
        // Device orientation
        const angle = this.getDeviceAngle(); // 0,90,180,270
        const wantPortrait = (angle === 0 || angle === 180);
        const sensorLandscape = srcW >= srcH;
        let deg = 0;
        // If desired device orientation differs from sensor aspect, rotate 90 to swap
        if (wantPortrait === sensorLandscape) {
            deg = (this.rotationPreference === 'cw' ? 90 : 270);
        }
        // If device is upside-down variants, add 180 to keep top-up
        if (angle === 180 || angle === 270) {
            deg = (deg + 180) % 360;
        }

        const context = this.canvas.getContext('2d');
        if (deg === 90 || deg === 270) {
            this.canvas.width = srcH;
            this.canvas.height = srcW;
        } else {
            this.canvas.width = srcW;
            this.canvas.height = srcH;
        }
        context.save();
        if (deg === 90) {
            context.translate(this.canvas.width, 0);
            context.rotate(Math.PI/2);
        } else if (deg === 180) {
            context.translate(this.canvas.width, this.canvas.height);
            context.rotate(Math.PI);
        } else if (deg === 270) {
            context.translate(0, this.canvas.height);
            context.rotate(-Math.PI/2);
        }
        context.drawImage(this.video, 0, 0, srcW, srcH);
        context.restore();
        
        // Get GPS location
        let gpsData = '';
        try {
            const position = await this.getCurrentLocation();
            if (position) {
                gpsData = `${position.coords.latitude.toFixed(6)},${position.coords.longitude.toFixed(6)}`;
            }
        } catch (error) {
            console.log('GPS not available:', error);
            // GPS is optional, continue without it
        }
        
        // Convert to blob
        this.canvas.toBlob((blob) => {
            // Get note at capture time: mobile keyboard dictation or in-app recorder
            let voiceComment = '';
            let voiceConfidence = 0;
            if (this.useKeyboardDictation) {
                voiceComment = (this.pendingDictation || '').trim();
                voiceConfidence = voiceComment ? 0.9 : 0;
                if (!this.keepDictation) { this.pendingDictation = ''; }
            } else {
                voiceComment = this.voiceRecorder && this.isVoiceEnabled 
                    ? this.voiceRecorder.getFinalTranscript() 
                    : '';
                voiceConfidence = this.voiceRecorder ? this.voiceRecorder.getConfidence() : 0;
            }
            
            const photoData = {
                id: Date.now(),
                blob: blob,
                dataUrl: this.canvas.toDataURL('image/jpeg', 0.8),
                timestamp: new Date(),
                voiceComment: voiceComment.trim(),
                voiceConfidence: voiceConfidence,
                gps: gpsData
            };
            
            this.capturedPhotos.push(photoData);
            this.updateUI();
            
            // Log voice comment for debugging
            if (voiceComment.trim()) {
                console.log('🎙️ [CAMERA] Photo captured with voice comment:', voiceComment);
            }
            
            // Reset voice transcript for next photo
            if (!this.useKeyboardDictation && this.voiceRecorder && this.isVoiceEnabled) {
                this.currentVoiceTranscript = '';
                // Restart voice recording for continuous capture
                setTimeout(() => {
                    if (this.isActive && this.isVoiceEnabled) {
                        this.voiceRecorder.stop();
                        setTimeout(() => this.startVoiceRecording(), 500);
                    }
                }, 100);
            }
            
        }, 'image/jpeg', 0.8);
    }

    showFlashEffect() {
        const flash = document.createElement('div');
        flash.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: white;
            z-index: 10000;
            opacity: 0.8;
            pointer-events: none;
        `;
        
        document.body.appendChild(flash);
        
        setTimeout(() => {
            flash.remove();
        }, 100);
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
            // Stop current stream
            this.stream.getTracks().forEach(track => track.stop());
            
            // Switch between front and back camera
            const currentFacingMode = this.stream.getVideoTracks()[0].getSettings().facingMode;
            const newFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
            
            this.stream = await navigator.mediaDevices.getUserMedia({ 
                video: { 
                    facingMode: newFacingMode,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                } 
            });
            
            this.video.srcObject = this.stream;
            
        } catch (error) {
            console.error('Failed to switch camera:', error);
        }
    }

    showGallery() {
        // TODO: Implement gallery view to review captured photos
        alert(`You have captured ${this.capturedPhotos.length} photos. Gallery view coming soon!`);
    }

    async uploadAll() {
        if (this.capturedPhotos.length === 0) return;
        
        showProgress(`Uploading ${this.capturedPhotos.length} photo${this.capturedPhotos.length !== 1 ? 's' : ''}...`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (let i = 0; i < this.capturedPhotos.length; i++) {
            const photo = this.capturedPhotos[i];
            const progress = Math.round(((i + 1) / this.capturedPhotos.length) * 100);
            
            try {
                showProgress(`Uploading photo ${i + 1}/${this.capturedPhotos.length}...`);
                setProgress(progress);
                
                await this.uploadSinglePhoto(photo);
                successCount++;
                
            } catch (error) {
                console.error(`Failed to upload photo ${i + 1}:`, error);
                failCount++;
            }
        }
        
        hideProgress();
        
        if (successCount > 0) {
            if (failCount > 0) {
                alert(`Upload completed! ${successCount} photos uploaded successfully, ${failCount} failed.`);
            } else {
                alert(`All ${successCount} photos uploaded successfully!`);
            }
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
        
        // Include voice comment if available
        if (photo.voiceComment && photo.voiceComment.trim()) {
            formData.append('voice_comment', photo.voiceComment);
            formData.append('voice_confidence', photo.voiceConfidence || 0);
            console.log('🎙️ [CAMERA] Uploading photo with voice comment:', photo.voiceComment);
        }
        
        // Include GPS data if available
        if (photo.gps && photo.gps.trim()) {
            formData.append('gps', photo.gps);
            console.log('📍 [CAMERA] Uploading photo with GPS:', photo.gps);
        }
        
        // Add timestamp
        formData.append('timestamp', photo.timestamp.toISOString());
        
        const response = await fetch('/api/photos/local_upload', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }
        
        const result = await response.json();
        if (!result.ok) {
            throw new Error(result.error || 'Upload failed');
        }
    }

    closeCamera() {
        // Stop voice recording
        if (this.voiceRecorder && this.isVoiceEnabled) {
            this.voiceRecorder.stop();
        }
        
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        
        const overlay = document.getElementById('cameraOverlay');
        if (overlay) {
            overlay.remove();
        }
        
        this.isActive = false;
        this.stream = null;
        this.video = null;
        this.canvas = null;
        this.capturedPhotos = [];
        
        // Reset voice recording state
        this.voiceRecorder = null;
        this.isVoiceEnabled = true;
        this.currentVoiceTranscript = '';
        this.voiceStartTime = null;
    }

    showError(message) {
        alert(message);
    }

    // Voice Recording Methods
    setupVoiceRecording() {
        console.log('🎙️ [CAMERA] Setting up voice recording...');
        
        // Wait for voice recorder to be available
        const waitForVoiceRecorder = () => {
            if (window.getVoiceRecorder && window.getVoiceRecorder()) {
                this.voiceRecorder = window.getVoiceRecorder();
                this.initializeVoiceRecording();
            } else {
                setTimeout(waitForVoiceRecorder, 100);
            }
        };
        
        waitForVoiceRecorder();
    }

    initializeVoiceRecording() {
        if (!this.voiceRecorder || !this.voiceRecorder.isBrowserSupported()) {
            console.warn('⚠️ [CAMERA] Voice recording not supported');
            this.isVoiceEnabled = false;
            this.updateVoiceUI();
            return;
        }

        // Setup voice recorder callbacks
        this.voiceRecorder.onStart = () => {
            console.log('🎙️ [CAMERA] Voice recording started');
            this.voiceStartTime = Date.now();
            this.updateVoiceUI();
        };

        this.voiceRecorder.onEnd = () => {
            console.log('🎙️ [CAMERA] Voice recording ended');
            this.updateVoiceUI();
        };

        this.voiceRecorder.onResult = (result) => {
            this.currentVoiceTranscript = result.final || result.interim || '';
            this.updateVoiceTranscript();
        };

        this.voiceRecorder.onError = (error) => {
            console.error('❌ [CAMERA] Voice recording error:', error);
            this.isVoiceEnabled = false;
            this.updateVoiceUI();
        };

        // Start voice recording automatically
        if (this.isVoiceEnabled) {
            this.startVoiceRecording();
        }
    }

    startVoiceRecording() {
        if (!this.voiceRecorder || !this.isVoiceEnabled) return;

        const started = this.voiceRecorder.start();
        if (started) {
            console.log('🎙️ [CAMERA] Voice recording started successfully');
        } else {
            console.warn('⚠️ [CAMERA] Failed to start voice recording');
            this.isVoiceEnabled = false;
        }
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
        
        if (this.isVoiceEnabled) {
            this.startVoiceRecording();
        } else {
            this.stopVoiceRecording();
        }
        
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

        // Show current transcript if recording
        if (this.voiceRecorder && this.voiceRecorder.isRecordingActive() && this.currentVoiceTranscript.length > 0) {
            const truncated = this.currentVoiceTranscript.length > 50 
                ? this.currentVoiceTranscript.substring(0, 50) + '...' 
                : this.currentVoiceTranscript;
            text.textContent = `"${truncated}"`;
        }
    }

    // Preview utilities
    rotatePreview() {
        this.manualRotationDeg = (this.manualRotationDeg + 90) % 360;
        if (this.video) {
            this.video.style.transform = `rotate(${this.manualRotationDeg}deg)`;
        }
    }
    toggleFit() {
        this.fitMode = this.fitMode === 'contain' ? 'cover' : 'contain';
        const v = this.video; if (!v) return; v.style.objectFit = this.fitMode; const btn = document.getElementById('fitBtn'); if (btn) btn.textContent = this.fitMode === 'contain' ? 'Fit' : 'Fill';
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

    // Use device/screen orientation to derive a stable angle for capture
    getDeviceAngle() {
        try {
            if (screen && screen.orientation && typeof screen.orientation.angle === 'number') {
                return ((screen.orientation.angle % 360) + 360) % 360;
            }
        } catch(e){}
        return window.innerWidth >= window.innerHeight ? 90 : 0;
    }
}

// Global camera instance
let cameraCapture = null;

// Function to start camera (called from templates)
async function startCameraCapture(projectId) {
    if (cameraCapture && cameraCapture.isActive) {
        cameraCapture.closeCamera();
    }
    
    cameraCapture = new CameraCapture();
    await cameraCapture.startCamera(projectId);
}

// Check if camera is supported
function isCameraSupported() {
    // Check basic API support
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return false;
    }
    
    // Check if we're on HTTPS or localhost (required for camera access)
    const isSecure = location.protocol === 'https:' || 
                    location.hostname === 'localhost' || 
                    location.hostname === '127.0.0.1' ||
                    location.hostname.startsWith('192.168.') ||
                    location.hostname.startsWith('10.') ||
                    location.hostname.startsWith('172.');
    
    console.log('🔍 [CAMERA] Security check:', {
        protocol: location.protocol,
        hostname: location.hostname,
        isSecure: isSecure
    });
    
    return isSecure;
}
