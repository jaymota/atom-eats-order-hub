// Free readers that run on the phone or computer: photos (Tesseract.js), PDFs (pdf.js) and
// Excel files (SheetJS). Each is loaded only when first used, so the site stays quick.
import type { RawItem } from './parse'

export type Progress = (message: string, fraction?: number) => void

/** Reads the text in a screenshot or photo. The first time, the reader downloads (about 10 MB). */
export async function readImage(file: Blob, onProgress?: Progress): Promise<{ text: string; confidence: number }> {
  const { createWorker } = await import('tesseract.js')
  onProgress?.('Getting the text reader ready…', 0)
  const worker = await createWorker('eng', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.('Reading the picture…', m.progress)
      else if (/loading|initiali/i.test(m.status)) onProgress?.('Getting the text reader ready…', m.progress)
    },
  })
  try {
    const { data } = await worker.recognize(file)
    return { text: data.text, confidence: data.confidence }
  } finally {
    await worker.terminate()
  }
}

/** Reads shipping label photos: barcodes (ZXing, exact) and the printed text (Tesseract), one reader
 *  for all the photos so a day's batch is quick. */
export async function readLabels(files: Blob[], onProgress?: Progress, again?: (text: string, barcodes: string[]) => boolean): Promise<{ text: string; barcodes: string[] }[]> {
  const [{ createWorker }, { readBarcodes, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('tesseract.js'), import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ])
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } })
  onProgress?.('Getting the reader ready…', 0)
  const worker = await createWorker('eng')
  const out: { text: string; barcodes: string[] }[] = []
  try {
    for (const [i, f] of files.entries()) {
      onProgress?.(`Reading photo ${i + 1} of ${files.length}…`, i / files.length)
      const bmp = await createImageBitmap(f)
      const canvas = document.createElement('canvas')
      canvas.width = bmp.width; canvas.height = bmp.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const found = await readBarcodes(ctx.getImageData(0, 0, bmp.width, bmp.height), { tryHarder: true, formats: ['Code128', 'Code39', 'Code93', 'ITF'] }).catch(() => [])
      const barcodes = found.map((b) => b.text)
      let { text } = (await worker.recognize(f)).data
      // Unclear photo: read a grey copy at twice the size too (slower, so only when needed).
      if (again?.(text, barcodes)) {
        const big = document.createElement('canvas')
        big.width = bmp.width * 2; big.height = bmp.height * 2
        const b = big.getContext('2d')!
        b.filter = 'grayscale(1)'
        b.drawImage(bmp, 0, 0, big.width, big.height)
        text += `\n${(await worker.recognize(big)).data.text}`
      }
      out.push({ text, barcodes })
    }
  } finally {
    await worker.terminate()
  }
  return out
}

/** pdf.js, the "legacy" build: the normal one needs very new browsers (e.g. Uint8Array.toHex) and
 *  fails on older phones and laptops with "a.toHex is not a function". */
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // A fixed file name (copied in at build time), so a page left open across an update still finds it.
  pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`
  return pdfjs
}

/** Reads the text of a PDF, line by line (top to bottom on each page). */
export async function readPdf(file: Blob, onProgress?: Progress): Promise<string> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const out: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress?.(`Reading page ${p} of ${doc.numPages}…`, p / doc.numPages)
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const rows = new Map<number, { x: number; s: string }[]>()
    for (const it of content.items as { str: string; transform: number[] }[]) {
      if (!it.str?.trim()) continue
      const y = Math.round(it.transform[5] / 3) * 3
      rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4], s: it.str }])
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out.push(rows.get(y)!.sort((a, b) => a.x - b.x).map((r) => r.s.trim()).join('  '))
    }
    out.push('')
  }
  // A scanned PDF has no text inside: the caller can fall back to reading it as a picture.
  return out.join('\n').trim()
}

export interface SheetRead {
  text: string
  items: (RawItem & { ean?: string; rate?: number; basic?: number; mrp?: number })[]
  rows: unknown[][] // the first sheet, as it is
}

/** Reads an Excel PO. Finds the item table (description + quantity columns) when there is one. */
export async function readExcel(file: Blob): Promise<SheetRead> {
  const X = await import('xlsx')
  const wb = X.read(await file.arrayBuffer(), { type: 'array' })
  const textParts: string[] = []
  const items: SheetRead['items'] = []
  let first: unknown[][] = []
  for (const name of wb.SheetNames) {
    const rows = X.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, defval: '', raw: false })
    if (!first.length) first = rows
    for (const r of rows) if (r.some((c) => String(c).trim())) textParts.push(r.map((c) => String(c).trim()).filter(Boolean).join('  '))
    const h = rows.findIndex((r) => r.some((c) => /descr|item name|product name|particular/i.test(String(c))) && r.some((c) => /^\s*(qty|quantity|order qty|units?)\b/i.test(String(c))))
    if (h < 0) continue
    const head = rows[h].map((c) => String(c).toLowerCase())
    const col = (re: RegExp) => head.findIndex((c) => re.test(c))
    const cDesc = [col(/descr/), col(/item name|product name/), col(/particular/)].find((c) => c >= 0) ?? -1
    const cQty = col(/^\s*(qty|quantity|order qty|units?)\b/)
    const cEan = col(/upc|ean|barcode/)
    const cGram = col(/grammage|weight|size/)
    const cLanding = col(/landing/)
    const cBasic = col(/basic|cost price|unit price|rate/)
    const cMrp = col(/^mrp/)
    rows.slice(h + 1).forEach((r, k) => {
      const desc = String(r[cDesc] ?? '').trim()
      const qty = Number(String(r[cQty] ?? '').replace(/[^\d.]/g, ''))
      if (!desc || !qty) return
      items.push({
        text: [desc, cGram >= 0 ? r[cGram] : ''].filter(Boolean).join(' '),
        qty: Math.round(qty),
        line: k,
        ean: cEan >= 0 ? String(r[cEan]).replace(/\D/g, '') || undefined : undefined,
        rate: cLanding >= 0 ? Number(String(r[cLanding]).replace(/[^\d.]/g, '')) || undefined : undefined,   // incl. GST
        basic: cLanding < 0 && cBasic >= 0 ? Number(String(r[cBasic]).replace(/[^\d.]/g, '')) || undefined : undefined, // before GST
        mrp: cMrp >= 0 ? Number(String(r[cMrp]).replace(/[^\d.]/g, '')) || undefined : undefined,
      })
    })
  }
  return { text: textParts.join('\n'), items, rows: first }
}

/** Shrinks a photo before saving it, so the 1 GB of free file space lasts for years. */
export async function compressImage(file: File, maxSide = 1600, quality = 0.72): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality))
  return blob && blob.size < file.size ? blob : file
}

/** A scanned PDF (no text inside): draws each page as a picture and reads it. */
export async function readScannedPdf(file: Blob, onProgress?: Progress): Promise<string> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const texts: string[] = []
  for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
    onProgress?.(`Reading scanned page ${p} of ${doc.numPages}…`, (p - 1) / doc.numPages)
    const page = await doc.getPage(p)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'))
    texts.push((await readImage(blob, onProgress)).text)
  }
  return texts.join('\n\n')
}

/** Reads all the files of one PO (e.g. Blinkit's Excel + PDF): the text, the Excel item rows, and a fixed reader's result. */
export async function readPoFiles(files: (Blob & { name: string })[], subject = '', onProgress?: Progress) {
  const { readPo } = await import('./po')
  const parts: string[] = []
  const poFiles: { name: string; text?: string; rows?: unknown[][] }[] = []
  let sheetItems: SheetRead['items'] = []
  for (const f of files) {
    if (/\.(xlsx|xls|csv)$/i.test(f.name)) {
      onProgress?.('Reading the Excel file…')
      const r = await readExcel(f)
      parts.push(r.text)
      if (!sheetItems.length) sheetItems = r.items
      poFiles.push({ name: f.name, rows: r.rows })
    } else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      let t = await readPdf(f, onProgress)
      if (t.replace(/\s/g, '').length < 40) {
        const { cleanOcr } = await import('./parse')
        t = cleanOcr(await readScannedPdf(f, onProgress))
      }
      parts.push(t)
      poFiles.push({ name: f.name, text: t })
    }
  }
  return { text: parts.join('\n\n'), sheetItems, po: readPo(poFiles, subject) }
}
