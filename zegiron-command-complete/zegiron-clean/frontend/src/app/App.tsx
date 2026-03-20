/**
 * ZEGIRON Command — App Root
 * frontend/src/app/App.tsx
 */

import React from 'react';
import { TacticalDisplay } from '../components/TacticalDisplay';

export const App: React.FC = () => (
  <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#04090f' }}>
    <TacticalDisplay />
  </div>
);
