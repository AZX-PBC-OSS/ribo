/**
 * Extraction accuracy report — inspector panel and grid keyboard navigation.
 *
 * Loaded from the generated docs/deep-dives/accuracy.md with
 *   <script src="/accuracy-report.js" defer></script>
 *
 * One IIFE, no globals, no framework, no dependency. Plain ES2015+.
 *
 * What it does — one job: clicking a marked square opens that slot's full
 * detail in a panel pinned under the grid, instead of scrolling you away to
 * the Problems section. It also gives the grid arrow-key navigation, because
 * 191 tab stops is not navigation.
 *
 * What it does not do: no rendering, no data, no templating. Every string it
 * shows is already in the DOM inside its #p-NN entry; the panel shows a clone.
 * There is exactly one copy of every fact on this page.
 *
 * Design: docs/roadmap/design/accuracy-report-visual-design.md §7
 */
(function () {
  "use strict";

  // Delegated from document, so VitePress client-side route changes need no re-binding.
  document.addEventListener("click", function (ev) {
    var close = ev.target.closest("[data-ar-close]");
    if (close) {
      hide(close.closest(".ar-inspect"));
      return;
    }

    var link = ev.target.closest(".ar-c a[data-ar-p]");
    if (!link) return;

    var root = link.closest(".ar");
    var panel = root && root.querySelector(".ar-inspect");
    var entry = root && root.querySelector("#" + link.dataset.arP);
    if (!panel || !entry) return; // fall through to the anchor jump

    ev.preventDefault();
    show(root, panel, entry, link.closest(".ar-c"));
  });

  document.addEventListener("keydown", function (ev) {
    var cell = ev.target.closest ? ev.target.closest(".ar-c") : null;

    if (ev.key === "Escape") {
      var open = document.querySelector(".ar .ar-inspect:not([hidden])");
      if (open) {
        hide(open);
        ev.preventDefault();
      }
      return;
    }
    if (!cell) return;

    var dir = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[
      ev.key
    ];
    if (!dir) return;

    var row = cell.parentElement;
    var cells = Array.prototype.slice.call(row.querySelectorAll(".ar-c"));
    var x = cells.indexOf(cell);
    var next = null;

    if (dir[1]) {
      next = cells[x + dir[1]];
    } else {
      var rows = Array.prototype.slice.call(
        row.closest("table").querySelectorAll("tr.ar-row:not([hidden])"),
      );
      var y = rows.indexOf(row);
      var target = rows[y + dir[0]];
      if (target) next = target.querySelectorAll(".ar-c")[x];
    }
    if (!next) return;

    ev.preventDefault();
    focusCell(next);
  });

  function focusCell(cell) {
    var a = cell.querySelector("a[data-ar-p]");
    if (a) {
      a.focus();
      return;
    }
    cell.tabIndex = -1;
    cell.focus(); // empty squares are reachable but silent
  }

  function show(root, panel, entry, cell) {
    var body = entry.querySelector(".ar-p-body");
    var head = entry.querySelector("summary");
    if (!body || !head) return;

    panel.querySelector(".ar-inspect-t").innerHTML = head.innerHTML;
    var dest = panel.querySelector(".ar-inspect-body");
    dest.textContent = "";
    dest.appendChild(body.cloneNode(true));
    panel.hidden = false;

    root.querySelectorAll(".ar-c.is-sel").forEach(function (n) {
      n.classList.remove("is-sel");
    });
    if (cell) cell.classList.add("is-sel");

    root.querySelectorAll("details.ar-p.is-cited").forEach(function (n) {
      n.classList.remove("is-cited");
    });
    entry.classList.add("is-cited");
    entry.open = true; // so a later print or Ctrl-F finds it
  }

  function hide(panel) {
    if (!panel) return;
    panel.hidden = true;
    var root = panel.closest(".ar");
    if (!root) return;
    root.querySelectorAll(".ar-c.is-sel").forEach(function (n) {
      n.classList.remove("is-sel");
    });
    root.querySelectorAll("details.ar-p.is-cited").forEach(function (n) {
      n.classList.remove("is-cited");
    });
  }
})();
