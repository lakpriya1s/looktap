// The `ls` row format, the same as lib/screen.js formatRow (test/site.test.js keeps the two identical), so the
// demo terminal prints exactly what looktap prints for the elements drawn on the demo phone.
export function formatRow(e, ref) {
  const label = e.label ? e.label.slice(0, 90) : '(no label)';
  const value = e.value && e.value !== e.label ? `  = ${e.value.slice(0, 40)}` : '';
  return `@${String(ref).padEnd(3)} ${e.type.slice(0, 14).padEnd(14)} ${String(e.x).padStart(4)},${String(e.y).padStart(4)} ${e.w}x${e.h}  ${label}${value}`;
}
