// Общие константы мира и камеры.

// --- Сетка/земля ---
export const CELL = 10.0;        // размер клетки в метрах
export const MAJOR = 50.0;       // крупные линии каждые 5 клеток
export const GROUND_SIZE = 500;  // сторона плоскости, следующей за камерой
export const FADE_START = 170;   // радиус начала растворения сетки
export const FADE_END = 245;     // радиус полного растворения

// --- Камера преследования ---
export const CAM_DEFAULT = { dist: 5, height: 3.5, orbit: 0 };
export const CAM_MIN_DIST = 3;
export const CAM_MAX_DIST = 100;
export const CAM_MIN_HEIGHT = 0.5;
export const CAM_MAX_HEIGHT = 40;
export const CAM_HEIGHT_SPEED = 8;      // Q/E, м/с
export const CAM_ORBIT_SENSITIVITY = 0.008;
export const CAM_HEIGHT_SENSITIVITY = 0.04;
