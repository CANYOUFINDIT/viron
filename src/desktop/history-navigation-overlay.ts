export const HISTORY_NAVIGATION_OVERLAY_CSS = `
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
.handle {
  width: 100%;
  height: 100%;
  background: #5d9ad6;
  color: white;
  display: grid;
  place-items: center;
  box-shadow: 0 5px 14px rgba(18, 67, 112, .28);
}
html[data-direction="back"] .handle { border-radius: 0 18px 18px 0; }
html[data-direction="forward"] .handle { border-radius: 18px 0 0 18px; }
.chevron {
  width: 18px;
  height: 18px;
  border-top: 3px solid currentColor;
  border-right: 3px solid currentColor;
}
html[data-direction="back"] .chevron { transform: rotate(-135deg); }
html[data-direction="forward"] .chevron { transform: rotate(45deg); }
`;

export const HISTORY_NAVIGATION_OVERLAY_HTML = `<!doctype html>
<html lang="en" data-direction="back">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
  <title>Viron History Navigation</title>
  <style>${HISTORY_NAVIGATION_OVERLAY_CSS}</style>
</head>
<body>
  <div class="handle" aria-hidden="true"><i class="chevron"></i></div>
</body>
</html>
`;
