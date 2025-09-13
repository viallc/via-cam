// PICKCAM Permission Diagnostics Tool
// Helps diagnose camera and microphone permission issues

class PermissionDiagnostics {
    constructor() {
        this.results = {
            protocol: location.protocol,
            hostname: location.hostname,
            userAgent: navigator.userAgent,
            mediaDevicesSupported: !!navigator.mediaDevices,
            getUserMediaSupported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
            speechRecognitionSupported: 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
        };
    }

    async runDiagnostics() {
        console.log('🔍 [DIAGNOSTICS] Running permission diagnostics...');
        
        // Basic API checks
        this.checkBasicSupport();
        
        // Protocol security check
        this.checkSecurity();
        
        // Browser compatibility
        this.checkBrowserCompatibility();
        
        // Permission status
        await this.checkPermissions();
        
        // Test actual access
        await this.testCameraAccess();
        await this.testMicrophoneAccess();
        
        this.displayResults();
        return this.results;
    }

    checkBasicSupport() {
        console.log('📋 [DIAGNOSTICS] Checking basic API support...');
        
        this.results.mediaDevicesAPI = !!navigator.mediaDevices;
        this.results.getUserMediaAPI = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
        this.results.speechRecognitionAPI = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
        
        console.log('✅ Media Devices API:', this.results.mediaDevicesAPI);
        console.log('✅ getUserMedia API:', this.results.getUserMediaAPI);
        console.log('✅ Speech Recognition API:', this.results.speechRecognitionAPI);
    }

    checkSecurity() {
        console.log('🔒 [DIAGNOSTICS] Checking security requirements...');
        
        const isSecure = location.protocol === 'https:' || 
                        location.hostname === 'localhost' || 
                        location.hostname === '127.0.0.1';
        
        this.results.isSecureContext = isSecure;
        this.results.securityIssue = !isSecure;
        
        if (isSecure) {
            console.log('✅ Secure context:', location.protocol + '//' + location.hostname);
        } else {
            console.log('❌ SECURITY ISSUE: Not in secure context');
            console.log('   Current:', location.protocol + '//' + location.hostname);
            console.log('   Required: HTTPS, localhost, or 127.0.0.1');
        }
    }

    checkBrowserCompatibility() {
        console.log('🌐 [DIAGNOSTICS] Checking browser compatibility...');
        
        const userAgent = navigator.userAgent.toLowerCase();
        this.results.browser = {
            chrome: userAgent.includes('chrome'),
            safari: userAgent.includes('safari') && !userAgent.includes('chrome'),
            firefox: userAgent.includes('firefox'),
            edge: userAgent.includes('edge'),
            mobile: /android|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent)
        };
        
        console.log('📱 Browser detection:', this.results.browser);
    }

    async checkPermissions() {
        console.log('🔐 [DIAGNOSTICS] Checking permission status...');
        
        if (!navigator.permissions) {
            console.log('⚠️ Permissions API not available');
            this.results.permissionsAPI = false;
            return;
        }
        
        this.results.permissionsAPI = true;
        
        try {
            // Check camera permission
            const cameraPermission = await navigator.permissions.query({ name: 'camera' });
            this.results.cameraPermission = cameraPermission.state;
            console.log('📷 Camera permission:', cameraPermission.state);
            
            // Check microphone permission
            const micPermission = await navigator.permissions.query({ name: 'microphone' });
            this.results.microphonePermission = micPermission.state;
            console.log('🎙️ Microphone permission:', micPermission.state);
            
        } catch (error) {
            console.log('⚠️ Could not check permissions:', error.message);
            this.results.permissionCheckError = error.message;
        }
    }

    async testCameraAccess() {
        console.log('📷 [DIAGNOSTICS] Testing camera access...');
        
        if (!this.results.getUserMediaAPI) {
            console.log('❌ Cannot test camera - getUserMedia not supported');
            this.results.cameraTest = 'not_supported';
            return;
        }
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { 
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                } 
            });
            
            console.log('✅ Camera access successful');
            this.results.cameraTest = 'success';
            this.results.cameraCapabilities = stream.getVideoTracks()[0].getCapabilities();
            
            // Clean up
            stream.getTracks().forEach(track => track.stop());
            
        } catch (error) {
            console.log('❌ Camera access failed:', error.name, error.message);
            this.results.cameraTest = 'failed';
            this.results.cameraError = {
                name: error.name,
                message: error.message
            };
        }
    }

    async testMicrophoneAccess() {
        console.log('🎙️ [DIAGNOSTICS] Testing microphone access...');
        
        if (!this.results.getUserMediaAPI) {
            console.log('❌ Cannot test microphone - getUserMedia not supported');
            this.results.microphoneTest = 'not_supported';
            return;
        }
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            console.log('✅ Microphone access successful');
            this.results.microphoneTest = 'success';
            this.results.microphoneCapabilities = stream.getAudioTracks()[0].getCapabilities();
            
            // Clean up
            stream.getTracks().forEach(track => track.stop());
            
        } catch (error) {
            console.log('❌ Microphone access failed:', error.name, error.message);
            this.results.microphoneTest = 'failed';
            this.results.microphoneError = {
                name: error.name,
                message: error.message
            };
        }
    }

    displayResults() {
        console.log('📊 [DIAGNOSTICS] Final Results:', this.results);
        
        // Create summary
        const issues = [];
        const recommendations = [];
        
        if (this.results.securityIssue) {
            issues.push('❌ Security: Not in secure context');
            recommendations.push('✅ Use https:// or access via localhost/127.0.0.1');
        }
        
        if (!this.results.getUserMediaAPI) {
            issues.push('❌ API: getUserMedia not supported');
            recommendations.push('✅ Use Chrome, Safari, or Edge browser');
        }
        
        if (this.results.cameraTest === 'failed') {
            issues.push(`❌ Camera: ${this.results.cameraError?.name || 'Access denied'}`);
            recommendations.push('✅ Allow camera permissions when prompted');
        }
        
        if (this.results.microphoneTest === 'failed') {
            issues.push(`❌ Microphone: ${this.results.microphoneError?.name || 'Access denied'}`);
            recommendations.push('✅ Allow microphone permissions when prompted');
        }
        
        if (!this.results.speechRecognitionAPI) {
            issues.push('❌ Speech: Web Speech API not supported');
            recommendations.push('✅ Use Chrome for best speech recognition support');
        }
        
        console.log('\n🔍 DIAGNOSIS SUMMARY:');
        if (issues.length === 0) {
            console.log('✅ All systems working correctly!');
        } else {
            console.log('Issues found:');
            issues.forEach(issue => console.log(issue));
            console.log('\nRecommendations:');
            recommendations.forEach(rec => console.log(rec));
        }
        
        // Store results for display
        window.permissionDiagnosticsResults = this.results;
    }

    getErrorSolution(errorName) {
        const solutions = {
            'NotAllowedError': 'Camera/microphone permission denied. Click the camera icon in address bar and allow permissions, then refresh the page.',
            'NotFoundError': 'No camera or microphone found. Check that your device has these hardware components.',
            'NotSupportedError': 'Browser doesn\'t support camera/microphone access. Use Chrome, Safari, or Edge.',
            'NotReadableError': 'Camera/microphone is being used by another app. Close other camera apps and try again.',
            'OverconstrainedError': 'Camera/microphone constraints not supported. Try with different settings.',
            'SecurityError': 'Access denied due to security restrictions. Ensure you\'re using HTTPS or localhost.',
            'AbortError': 'Operation was aborted. Try again.',
            'TypeError': 'Invalid constraints. Check camera/microphone settings.'
        };
        
        return solutions[errorName] || `Unknown error: ${errorName}. Try refreshing the page or restarting the browser.`;
    }
}

// Global diagnostics instance
window.PermissionDiagnostics = PermissionDiagnostics;

// Quick diagnostic function
window.checkPermissions = async function() {
    const diagnostics = new PermissionDiagnostics();
    return await diagnostics.runDiagnostics();
};

console.log('🔍 [DIAGNOSTICS] Permission diagnostics loaded. Run checkPermissions() to test.');
