
// Mobile Navigation Functions
function toggleMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobileOverlay');
  
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.contains('open');
    
    if (isOpen) {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    } else {
      sidebar.classList.add('open');
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden'; // Prevent background scroll
    }
  }
}

// Close menu when clicking on navigation links (mobile)
function closeMobileMenuOnLinkClick() {
  const navLinks = document.querySelectorAll('.navlink');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        setTimeout(() => {
          toggleMobileMenu();
        }, 100); // Small delay for better UX
      }
    });
  });
}

// Handle window resize
function handleResize() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobileOverlay');
  
  if (window.innerWidth > 768) {
    // Desktop: ensure sidebar is visible and overlay is hidden
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    document.body.style.overflow = '';
  }
}

// Initialize mobile navigation
document.addEventListener('DOMContentLoaded', function() {
  closeMobileMenuOnLinkClick();
  window.addEventListener('resize', handleResize);
});

// Legacy function for compatibility
function toggleSidebar() {
  toggleMobileMenu();
}
