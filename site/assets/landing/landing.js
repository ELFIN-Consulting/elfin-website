/* Landing pages: switch the main navigation to the burger menu ("…")
   whenever the menu items do not fit next to the logo. Enfold only does
   this below 990px; long German labels need it up to ~1300px.
   Uses Enfold's own burger and overlay, so no other change is needed. */
(function () {
  var root = document.documentElement;
  var CLS = "lp-nav-collapse";

  // keep = true: only ever add the class (used while scrolling, because
  // Enfold's shrinking header changes the space; a full re-check runs on resize)
  function check(keep) {
    if (keep === true && root.classList.contains(CLS)) return;
    root.classList.remove(CLS);
    var logo = document.querySelector(".av-logo-container .logo");
    var items = Array.prototype.filter.call(
      document.querySelectorAll("#top .av-main-nav > li.menu-item"),
      function (li) { return li.offsetParent !== null; }
    );
    if (!logo || !items.length) return; // Enfold's own burger is active
    var logoRight = logo.getBoundingClientRect().right;
    var top = items[0].getBoundingClientRect().top;
    var tooWide = items.some(function (li) {
      var r = li.getBoundingClientRect();
      return r.left < logoRight + 20 || Math.abs(r.top - top) > 2 || r.right > root.clientWidth;
    });
    root.classList.toggle(CLS, tooWide);
  }

  var t;
  window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(check, 100); });
  window.addEventListener("scroll", function () { check(true); }, { passive: true });
  window.addEventListener("load", check);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(check);
  check();
})();
