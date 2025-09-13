/**
 * PickCam Voice Recording System
 * Using Web Speech API (Free)
 * Converts speech to text for photo comments
 */

class VoiceRecorder {
  constructor() {
    this.recognition = null;
    this.isRecording = false;
    this.isSupported = false;
    this.currentTranscript = '';
    this.finalTranscript = '';
    this.confidence = 0;
    
    // Settings
    this.language = this.detectLanguage(); // Auto-detect or default to English
    this.continuous = true;
    this.interimResults = true;
    this.maxAlternatives = 1;
    
    // Callbacks
    this.onStart = null;
    this.onEnd = null;
    this.onResult = null;
    this.onError = null;
    
    this.init();
  }
  
  detectLanguage() {
    // Try to detect browser language
    const browserLang = navigator.language || navigator.userLanguage;
    
    // Map common languages to speech recognition codes
    const languageMap = {
      'en': 'en-US',
      'es': 'es-ES', 
      'fr': 'fr-FR',
      'de': 'de-DE',
      'it': 'it-IT',
      'pt': 'pt-BR',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'zh': 'zh-CN'
    };
    
    // Extract language code (e.g., 'en' from 'en-US')
    const langCode = browserLang ? browserLang.split('-')[0] : 'en';
    
    // Return mapped language or default to English
    const detectedLang = languageMap[langCode] || 'en-US';
    
    console.log(`🎙️ [VOICE] Browser language: ${browserLang}, Using: ${detectedLang}`);
    return detectedLang;
  }
  
  init() {
    // Check browser support
    if ('webkitSpeechRecognition' in window) {
      this.recognition = new webkitSpeechRecognition();
      this.isSupported = true;
      console.log('🎙️ [VOICE] Web Speech API supported');
    } else if ('SpeechRecognition' in window) {
      this.recognition = new SpeechRecognition();
      this.isSupported = true;
      console.log('🎙️ [VOICE] Web Speech API supported');
    } else {
      console.warn('⚠️ [VOICE] Web Speech API not supported in this browser');
      return;
    }
    
    this.setupRecognition();
  }
  
  setupRecognition() {
    if (!this.recognition) return;
    
    // Configure recognition
    this.recognition.continuous = this.continuous;
    this.recognition.interimResults = this.interimResults;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = this.maxAlternatives;
    
    // Event handlers
    this.recognition.onstart = () => {
      this.isRecording = true;
      console.log('🎙️ [VOICE] Recording started');
      if (this.onStart) this.onStart();
    };
    
    this.recognition.onend = () => {
      this.isRecording = false;
      console.log('🎙️ [VOICE] Recording ended');
      if (this.onEnd) this.onEnd();
    };
    
    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        const confidence = event.results[i][0].confidence;
        
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
          this.confidence = confidence;
        } else {
          interimTranscript += transcript;
        }
      }
      
      this.currentTranscript = interimTranscript;
      this.finalTranscript = finalTranscript;
      
      console.log('🎙️ [VOICE] Transcript:', {
        interim: interimTranscript,
        final: finalTranscript,
        confidence: this.confidence
      });
      
      if (this.onResult) {
        this.onResult({
          interim: interimTranscript,
          final: finalTranscript,
          confidence: this.confidence
        });
      }
    };
    
    this.recognition.onerror = (event) => {
      console.error('❌ [VOICE] Recognition error:', event.error);
      this.isRecording = false;
      
      if (this.onError) {
        this.onError({
          error: event.error,
          message: this.getErrorMessage(event.error)
        });
      }
    };
    
    this.recognition.onnomatch = () => {
      console.warn('⚠️ [VOICE] No speech was recognized');
    };
  }
  
  start() {
    if (!this.isSupported) {
      console.warn('⚠️ [VOICE] Cannot start - not supported');
      return false;
    }
    
    if (this.isRecording) {
      console.warn('⚠️ [VOICE] Already recording');
      return false;
    }
    
    try {
      this.currentTranscript = '';
      this.finalTranscript = '';
      this.confidence = 0;
      this.recognition.start();
      return true;
    } catch (error) {
      console.error('❌ [VOICE] Error starting recognition:', error);
      return false;
    }
  }
  
  stop() {
    if (!this.isRecording) return false;
    
    try {
      this.recognition.stop();
      return true;
    } catch (error) {
      console.error('❌ [VOICE] Error stopping recognition:', error);
      return false;
    }
  }
  
  abort() {
    if (!this.isRecording) return false;
    
    try {
      this.recognition.abort();
      this.isRecording = false;
      return true;
    } catch (error) {
      console.error('❌ [VOICE] Error aborting recognition:', error);
      return false;
    }
  }
  
  getFullTranscript() {
    return (this.finalTranscript + ' ' + this.currentTranscript).trim();
  }
  
  getFinalTranscript() {
    return this.finalTranscript.trim();
  }
  
  getCurrentTranscript() {
    return this.currentTranscript.trim();
  }
  
  getConfidence() {
    return this.confidence;
  }
  
  setLanguage(lang) {
    this.language = lang;
    if (this.recognition) {
      this.recognition.lang = lang;
    }
  }
  
  getErrorMessage(error) {
    const errorMessages = {
      'network': 'Network error occurred. Please check your connection.',
      'not-allowed': 'Microphone access denied. Please enable microphone permissions.',
      'no-speech': 'No speech was detected. Please try speaking louder.',
      'audio-capture': 'Audio capture failed. Please check your microphone.',
      'aborted': 'Speech recognition was aborted.',
      'language-not-supported': 'Language not supported.',
      'service-not-allowed': 'Speech recognition service not allowed.'
    };
    
    return errorMessages[error] || `Speech recognition error: ${error}`;
  }
  
  // Utility methods
  isRecordingActive() {
    return this.isRecording;
  }
  
  isBrowserSupported() {
    return this.isSupported;
  }
}

// Global voice recorder instance
let globalVoiceRecorder = null;

// Initialize voice recorder when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  globalVoiceRecorder = new VoiceRecorder();
  console.log('🎙️ [VOICE] Voice recorder initialized');
});

// Export for use in other scripts
window.VoiceRecorder = VoiceRecorder;
window.getVoiceRecorder = function() {
  return globalVoiceRecorder;
};
