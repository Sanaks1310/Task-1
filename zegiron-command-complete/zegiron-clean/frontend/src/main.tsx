/**
 * ZEGIRON Command — Frontend Entry Point
 * frontend/src/main.tsx
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

// Global reset
const style = document.createElement('style');
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { width: 100%; height: 100%; overflow: hidden; }
  body { background: #04090f; }
`;
document.head.appendChild(style);

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
