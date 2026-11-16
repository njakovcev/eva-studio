import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

// A trackpad pinch reaches the page as a wheel event with ctrlKey set. Left alone, the browser
// magnifies the whole page (toolbar and all) instead of the drawing. Block that everywhere;
// the 3D view and the 2D editor handle the pinch themselves as their own zoom.
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
// Safari reports pinches as gesture events.
for (const type of ['gesturestart', 'gesturechange']) window.addEventListener(type, (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
