// Presentation belongs only to the live editor DOM. Save replays edits onto the
// original HTML; capture temporarily disables this sheet to export every page.
export function showEditorPage(doc: Document, index: number): { w: number; h: number } | null {
  const pages = [...doc.querySelectorAll<HTMLElement>('.hs-page')];
  const page = pages[index];
  if (!page) return null;

  let sheet = doc.getElementById('hs-editor-page-presentation') as HTMLStyleElement | null;
  if (!sheet) {
    sheet = doc.createElement('style');
    sheet.id = 'hs-editor-page-presentation';
    sheet.textContent = `
      .hs-page:not([data-hs-editor-active]), [data-hs-editor-hidden] { display:none !important; }
      [data-hs-editor-ancestor] {
        display:block !important; position:static !important; transform:none !important;
        margin:0 !important; padding:0 !important; border-width:0 !important;
        width:auto !important; height:auto !important; min-width:0 !important; min-height:0 !important;
        max-width:none !important; max-height:none !important; overflow:visible !important;
      }
      .hs-page[data-hs-editor-active] {
        position:relative !important; inset:auto !important; margin:0 !important; float:none !important;
      }
    `;
    doc.head.appendChild(sheet);
    const ancestors = new Set<HTMLElement>();
    pages.forEach((p) => {
      for (let parent = p.parentElement; parent; parent = parent.parentElement) ancestors.add(parent);
    });
    ancestors.forEach((parent) => {
      parent.setAttribute('data-hs-editor-ancestor', '');
      // Keep author CSS ancestry intact while hiding controls outside the artboards.
      for (const child of parent.children) {
        if (!ancestors.has(child as HTMLElement) && !child.matches('.hs-page, head, script, style, link')) {
          child.setAttribute('data-hs-editor-hidden', '');
        }
      }
    });
  }
  pages.forEach((p, i) => p.toggleAttribute('data-hs-editor-active', i === index));
  return { w: page.offsetWidth, h: page.offsetHeight };
}
