/**
 * 工具图标用内联 SVG，不用 emoji：手机厂商的 emoji 字体覆盖不全，
 * 🪪 🧮 📽️ 这类新码位会直接显示成豆腐块。
 */
const PATHS: Record<string, string[]> = {
  'image-compress': ['M3 17l5-5 4 4 3-3 6 6', 'M3 5h18v14H3z', 'M8 9h.01'],
  'idphoto-compress': ['M3 4h18v16H3z', 'M9 11a2.2 2.2 0 100-4.4A2.2 2.2 0 009 11z', 'M5.5 17c.7-2.2 2-3.2 3.5-3.2s2.8 1 3.5 3.2', 'M15 9h4M15 12h4'],
  'pdf-compress': ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M12 10v6', 'M9.5 14l2.5 2.5L14.5 14'],
  'idphoto-size': ['M4 8h16M4 16h16M8 4v16M16 4v16', 'M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3'],
  'audio-compress': ['M4 12v0M7 8v8M10 5v14M13 9v6M16 6v12M19 11v2'],
  'gif-compress': ['M4 7a3 3 0 013-3h10a3 3 0 013 3v3a3 3 0 01-3 3H7a3 3 0 01-3-3z', 'M8 17h8M11 20h2'],
  'pdf-to-word': ['M4 4h9v16H4z', 'M6 8h5M6 11h5M6 14h3', 'M16 9l2 10 2-6 2 6 2-10'],
  'pdf-to-longimg': ['M5 3h9v18H5z', 'M8 7h3M8 11h3M8 15h3', 'M18 6v12M18 18l-2-2M18 18l2-2'],
  'pdf-to-pages': ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  'word-to-pdf': ['M4 4h9v16H4z', 'M6 8h5M6 11h5M6 14h3', 'M17 8v11M17 19l3-3M17 19l-3-3'],
  'img-to-pdf': ['M3 5h11v9H3z', 'M3 11l3-3 3 3 2-2 3 3', 'M17 12v9M17 21l3-3M17 21l-3-3'],
  'excel-to-pdf': ['M4 4h9v16H4z', 'M7 4v16M11 4v16M4 9h9M4 14h9', 'M17 12v9M17 21l3-3M17 21l-3-3'],
  'ppt-to-pdf': ['M3 4h13v9H3z', 'M9 13v4M6 19h6', 'M19 10v11M19 21l2.5-2.5M19 21l-2.5-2.5'],
  'pdf-to-ppt': ['M4 4h9v16H4z', 'M6 8h5M6 11h5', 'M15 8h7v6h-7z', 'M18.5 14v3M16 19h5'],
  'pdf-to-excel': ['M4 4h9v16H4z', 'M6 8h5M6 11h5M6 14h3', 'M15 8h7v11h-7z', 'M18.5 8v11M15 13.5h7'],
  'img-to-word': ['M3 4h11v8H3z', 'M3 9l3-3 3 3 2-2 3 3', 'M16 6l2 12 2-7 2 7 1-12'],
  'img-to-excel': ['M3 4h11v8H3z', 'M3 9l3-3 3 3 2-2 3 3', 'M16 12h7v9h-7z', 'M19.5 12v9M16 16.5h7'],
};

export function ToolIcon({ id, className = '' }: { id: string; className?: string }) {
  const paths = PATHS[id] ?? ['M4 4h16v16H4z'];
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
