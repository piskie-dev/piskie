import type { MermaidConfig } from 'mermaid';

export type MermaidTheme = 'dark' | 'light';
export interface MermaidDiagram {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

let mermaidModule: Promise<typeof import('mermaid')> | undefined;
let renderQueue = Promise.resolve();
let nextId = 0;

/** Initialize and render in one queue: Mermaid's configuration is shared across diagrams. */
export function renderMermaid(source: string, theme: MermaidTheme): Promise<MermaidDiagram> {
  const result = renderQueue.then(async () => {
    const { default: mermaid } = await (mermaidModule ??= import('mermaid'));
    await document.fonts?.ready;
    const config: MermaidConfig = {
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: 'system-ui, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
      suppressErrorRendering: true,
      arrowMarkerAbsolute: false,
    };
    mermaid.initialize({
      ...config,
      // Mermaid applies this protection to both frontmatter and init directives, recursively.
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), ...Object.keys(config), 'themeVariables', 'themeCSS'],
    });
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none';
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`mermaid-diagram-${++nextId}`, source, container);
      const element = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      const bounds = element.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      const width = bounds?.[2];
      const height = bounds?.[3];
      if (element.localName !== 'svg' || bounds?.length !== 4 || !bounds.every(Number.isFinite)
        || !width || !height || width <= 0 || height <= 0) {
        throw new Error('Mermaid did not produce a complete SVG viewBox');
      }
      // Use the full diagram, independently of the width of the Markdown viewport.
      element.setAttribute('width', String(Math.ceil(width)));
      element.setAttribute('height', String(Math.ceil(height)));
      element.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const svgElement = element as unknown as SVGSVGElement;
      svgElement.style.removeProperty('max-width');
      svgElement.style.backgroundColor = mermaid.mermaidAPI.getConfig().themeVariables.background;
      return { svg: new XMLSerializer().serializeToString(element), width: Math.ceil(width), height: Math.ceil(height) };
    } finally {
      container.remove();
    }
  });
  renderQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Rasterize the self-contained SVG at full bounds; no DOM or viewport screenshot is involved. */
export async function mermaidToPng(diagram: MermaidDiagram): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([diagram.svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unable to load the Mermaid SVG for copying'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    // Large diagrams still fit entirely within Chromium's canvas limits.
    const scale = Math.min(2, 16384 / diagram.width, 16384 / diagram.height,
      Math.sqrt(32_000_000 / (diagram.width * diagram.height)));
    canvas.width = Math.max(1, Math.ceil(diagram.width * scale));
    canvas.height = Math.max(1, Math.ceil(diagram.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable for copying the Mermaid diagram');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to encode the Mermaid diagram as PNG'));
    }, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
