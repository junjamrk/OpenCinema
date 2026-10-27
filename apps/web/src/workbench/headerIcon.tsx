// Material Symbols, Google. SPDX-License-Identifier: Apache-2.0.
// Original SVGs: https://github.com/google/material-design-icons/tree/master/symbols/web
const icons = {
  movieFilter: { viewBox: "0 0 24 24", path: "m9.5 11-.95 2.05L6.5 14l2.05.95L9.5 17l.95-2.05L12.5 14l-2.05-.95Zm6 0-.65 1.35-1.35.65 1.35.65.65 1.35.65-1.35L17.5 13l-1.35-.65ZM4 4l2 4h3L7 4h2l2 4h3l-2-4h2l2 4h3l-2-4h3q.825 0 1.413.588Q22 5.175 22 6v12q0 .825-.587 1.413Q20.825 20 20 20H4q-.825 0-1.412-.587Q2 18.825 2 18V6q0-.825.588-1.412Q3.175 4 4 4Zm0 6v8h16v-8Zm0 0v8Z" },
  description: { viewBox: "0 -960 960 960", path: "M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z" },
};

export default function HeaderIcon({ name, size }: { name: keyof typeof icons; size: number }) {
  const icon = icons[name];
  return <svg className="headerIcon" width={size} height={size} viewBox={icon.viewBox} fill="currentColor" aria-hidden="true" focusable="false"><path d={icon.path} /></svg>;
}
