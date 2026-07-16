/// <reference types="vite/client" />

declare module '*?raw' {
  const content: string;
  export default content;
}

// Fontsource packages expose only CSS via their exports map (no type
// declarations), so their bare side-effect imports need an ambient module.
declare module '@fontsource-variable/inter';
declare module '@fontsource/jetbrains-mono';
