/** Validate the desktop appearance stored alongside the web panel's display scale. */
export function desktopScale(value) {
  return Number.isFinite(value) && value >= 0.5 && value <= 2 ? value : null;
}

export function desktopAppearance(value) {
  const shellName = name => typeof name === 'string' && name.trim() && name.length <= 255 &&
    !/^[.]|[\\/:*?"<>|\x00-\x1f]|[. ]$/.test(name);
  const inRange = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!value || !shellName(value.shell) || (value.previous_shell !== null && !shellName(value.previous_shell)) ||
      !['top', 'normal', 'bottom'].includes(value.layer) || !inRange(value.theme, 2) || !inRange(value.size, 2) ||
      !inRange(value.bubble_time, 3) || typeof value.reduce_motion !== 'boolean' ||
      typeof value.hide_fullscreen !== 'boolean' || typeof value.recall_hotkey !== 'boolean') return null;
  const { shell, previous_shell, layer, theme, size, bubble_time, reduce_motion, hide_fullscreen, recall_hotkey } = value;
  return { shell, previous_shell, layer, theme, size, bubble_time, reduce_motion, hide_fullscreen, recall_hotkey };
}
