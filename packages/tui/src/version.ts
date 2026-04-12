declare const __PKG_VERSION__: string;
export const TUI_VERSION: string =
  typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.0.0-dev';
