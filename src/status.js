// Единственная строка состояния поверх сцены: загрузка, ошибки, потеря контекста.

const el = document.getElementById('status');

export function setStatus(text) {
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}

export function clearStatus() {
  if (!el) return;
  el.hidden = true;
}
