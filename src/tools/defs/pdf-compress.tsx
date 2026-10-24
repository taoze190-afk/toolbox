import { Hint, Panel, Row, Segmented } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { newPdfDoc, openPdf, pdfBlob, pdfHasTextLayer, renderPage } from '../../core/pdf';
import { encode, MIMES } from '../../core/images';
import { baseName, fmtBytes, uniqueName } from '../../core/format';
import { QUALITY_LEVELS } from '../../core/presets';

const MAX_SIDES = [
  { value: 4096, label: '4096' },
  { value: 2048, label: '2048' },
  { value: 1600, label: '1600' },
];

function level(id: string) {
  return QUALITY_LEVELS.find((l) => l.id === id) ?? QUALITY_LEVELS[1];
}

function Controls({ value, patch }: ControlsProps) {
  const lvl = level(value.level);
  return (
    <Panel>
      <Row label="压缩档位" hint={`${lvl.dpi} dpi · 质量 ${Math.round(lvl.quality * 100)}%`}>
        <Segmented
          value={value.level}
          onChange={(v) => patch({ level: v })}
          options={QUALITY_LEVELS.map((l) => ({ value: l.id as string, label: l.name }))}
        />
      </Row>
      <Row label="单边最大像素" hint="越小越省空间">
        <Segmented value={value.maxSide} onChange={(v) => patch({ maxSide: v })} options={MAX_SIDES} />
      </Row>
      <Hint>整页转成图片重新组装，扫描件效果最好；带文字层的文件压完文字不可选中。</Hint>
    </Panel>
  );
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const lvl = level(o.level);

  for (let k = 0; k < files.length; k++) {
    ctx.tick();
    const file = files[k];
    ctx.progress({ done: k, total: files.length, label: `${file.name} · 检测文字层` });

    const hasTextLayer = await pdfHasTextLayer(file);
    const src = await openPdf(file);
    const numPages = src.numPages;
    const out = await newPdfDoc();

    try {
      for (let p = 1; p <= numPages; p++) {
        ctx.tick();
        ctx.progress({ done: p - 1, total: numPages, label: `第 ${p}/${numPages} 页` });
        const { canvas, wPt, hPt } = await renderPage(src, p, lvl.dpi, o.maxSide);
        const jpg = await encode(canvas, MIMES.jpeg, lvl.quality);
        canvas.width = canvas.height = 0;

        const img = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
        const page = out.addPage([wPt, hPt]);
        page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
        await ctx.breathe();
      }
    } finally {
      await src.destroy();
    }

    ctx.tick();
    ctx.progress({ done: numPages - 1, total: numPages, label: '封装 PDF' });
    const bytes = await out.save({ useObjectStreams: true });
    const blob = pdfBlob(bytes);

    const parts = [`${numPages} 页`, `原 ${fmtBytes(file.size)} → 新 ${fmtBytes(blob.size)}`];
    if (blob.size >= file.size) parts.push('原文件可能已经压过');
    if (hasTextLayer) parts.push('文字层已丢失，不可选中');

    outs.push({ name: uniqueName(`${baseName(file.name)}.pdf`, taken), blob, kind: 'pdf', note: parts.join(' · ') });
  }
  return outs;
}

const tool: ToolDef = {
  id: 'pdf-compress',
  name: 'PDF 压缩',
  desc: '逐页转图重组成更小的 PDF',
  zone: 'compress',
  icon: '📉',
  accept: 'application/pdf,.pdf',
  multiple: false,
  inputHint: '页数多的文件会占用较多内存',
  defaults: { level: 'balanced', maxSide: 4096 },
  Controls,
  run,
};

export default tool;
