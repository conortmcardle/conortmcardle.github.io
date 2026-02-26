// Nav shadow on scroll
const nav = document.querySelector('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 10);
});

// Fade-in on scroll using IntersectionObserver
const fadeEls = document.querySelectorAll(
  '#about .container, .project-card, #contact .container'
);
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.1 }
);

fadeEls.forEach((el) => {
  el.classList.add('fade-in');
  observer.observe(el);
});
