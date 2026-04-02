import { useState, useRef, useCallback, useEffect } from "react";

// Use Vite's URL asset handling for the mockup PNG
const mockupSrc = new URL("../imports/iMockup_-_iPhone_15_Pro_Max.png", import.meta.url).href;

interface ProcessedImage {
  id: string;
  originalName: string;
  originalSrc: string;
  compositeSrc: string | null;
  status: "processing" | "done" | "error";
  errorMsg?: string;
}

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenInfo {
  bounds: ScreenBounds;
  cornerRadius: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

function detectScreenInfo(mockupImg: HTMLImageElement): ScreenInfo {
  const W = mockupImg.naturalWidth;
  const H = mockupImg.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(mockupImg, 0, 0);
  const { data } = ctx.getImageData(0, 0, W, H);

  // ── Step 1: mark all fully-transparent pixels ──────────────────────────────
  const isTransp = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    isTransp[i] = data[i * 4 + 3] < 10 ? 1 : 0;
  }

  // ── Step 2: BFS from image borders → "outer" transparent region (shadow/bg) ─
  // The phone frame is opaque, so this flood-fill can't reach the screen hole.
  const outer = new Uint8Array(W * H);
  const queue: number[] = [];

  const seed = (idx: number) => {
    if (isTransp[idx] && !outer[idx]) { outer[idx] = 1; queue.push(idx); }
  };

  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { seed(y * W); seed(y * W + W - 1); }

  for (let qi = 0; qi < queue.length; qi++) {
    const idx = queue[qi];
    const y = (idx / W) | 0;
    const x = idx % W;
    let n: number;
    n = idx - W; if (y > 0     && isTransp[n] && !outer[n]) { outer[n] = 1; queue.push(n); }
    n = idx + W; if (y < H - 1 && isTransp[n] && !outer[n]) { outer[n] = 1; queue.push(n); }
    n = idx - 1; if (x > 0     && isTransp[n] && !outer[n]) { outer[n] = 1; queue.push(n); }
    n = idx + 1; if (x < W - 1 && isTransp[n] && !outer[n]) { outer[n] = 1; queue.push(n); }
  }

  // ── Step 3: inner transparent pixels = screen hole ────────────────────────
  const rows: { y: number; left: number; right: number; span: number }[] = [];

  for (let y = 0; y < H; y++) {
    let left = -1, right = -1;
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (isTransp[idx] && !outer[idx]) {
        if (left === -1) left = x;
        right = x;
      }
    }
    if (left !== -1) rows.push({ y, left, right, span: right - left });
  }

  // Fallback: if no inner transparent found, treat ALL transparent as screen
  // (phone has no outer shadow)
  if (rows.length === 0) {
    for (let y = 0; y < H; y++) {
      let left = -1, right = -1;
      for (let x = 0; x < W; x++) {
        if (isTransp[y * W + x]) {
          if (left === -1) left = x;
          right = x;
        }
      }
      if (left !== -1) rows.push({ y, left, right, span: right - left });
    }
  }

  // Ultimate fallback
  if (rows.length === 0) {
    const fw = Math.round(W * 0.795), fh = Math.round(H * 0.851);
    return {
      bounds: { x: Math.round((W - fw) / 2), y: Math.round(H * 0.074), width: fw, height: fh },
      cornerRadius: Math.round(fw * 0.13),
    };
  }

  // ── Step 4: screen bounds from per-row data ────────────────────────────────
  let maxSpan = 0;
  for (const r of rows) if (r.span > maxSpan) maxSpan = r.span;

  const coreRows = rows.filter((r) => r.span >= maxSpan * 0.97);
  let screenLeft = W, screenRight = 0;
  for (const r of coreRows) {
    if (r.left  < screenLeft)  screenLeft  = r.left;
    if (r.right > screenRight) screenRight = r.right;
  }
  const screenWidth = screenRight - screenLeft + 1;
  const minY = rows[0].y;
  const maxY = rows[rows.length - 1].y;

  // ── Step 5: override to exact 1024 px wide, keep aspect ratio, center ──
  const targetW = 1024;
  const aspectRatio = (maxY - minY + 1) / screenWidth;
  const targetH = Math.round(targetW * aspectRatio);
  const centerX = screenLeft + screenWidth / 2;
  const centerY = (minY + maxY) / 2;

  return {
    bounds: {
      x: Math.round(centerX - targetW / 2),
      y: Math.round(centerY - targetH / 2),
      width: targetW,
      height: targetH,
    },
    cornerRadius: 120,
  };
}

async function compositeImage(
  screenshotSrc: string,
  mockupImg: HTMLImageElement,
  screenInfo: ScreenInfo
): Promise<string> {
  const { bounds, cornerRadius } = screenInfo;
  const canvas = document.createElement("canvas");
  canvas.width = mockupImg.naturalWidth;
  canvas.height = mockupImg.naturalHeight;
  const ctx = canvas.getContext("2d")!;

  const screenshot = await loadImage(screenshotSrc);

  // CONTAIN — never crops, preserves ratio
  const scaleX = bounds.width / screenshot.naturalWidth;
  const scaleY = bounds.height / screenshot.naturalHeight;
  const scale = Math.min(scaleX, scaleY);

  const scaledW = screenshot.naturalWidth * scale;
  const scaledH = screenshot.naturalHeight * scale;
  const drawX = bounds.x + (bounds.width - scaledW) / 2;
  const drawY = bounds.y + (bounds.height - scaledH) / 2;

  // ── Rounded-rect clip — nothing escapes the phone screen ──
  const { x, y, width, height } = bounds;
  const r = cornerRadius;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y,          x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x,         y + height, r);
  ctx.arcTo(x,         y + height, x,         y,          r);
  ctx.arcTo(x,         y,          x + width, y,          r);
  ctx.closePath();
  ctx.clip();

  // Black background for any letterbox areas
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, width, height);

  // Draw the screenshot
  ctx.drawImage(screenshot, drawX, drawY, scaledW, scaledH);
  ctx.restore();

  // Mockup frame on top — covers anti-aliased corners & shows Dynamic Island
  ctx.drawImage(mockupImg, 0, 0);

  return canvas.toDataURL("image/png");
}

function downloadBlob(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

async function downloadAll(images: ProcessedImage[]) {
  const done = images.filter((img) => img.status === "done" && img.compositeSrc);
  for (let i = 0; i < done.length; i++) {
    const img = done[i];
    const name = img.originalName.replace(/\.[^/.]+$/, "") + "_mockup.png";
    downloadBlob(img.compositeSrc!, name);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export default function App() {
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [mockupImg, setMockupImg] = useState<HTMLImageElement | null>(null);
  const [screenInfo, setScreenInfo] = useState<ScreenInfo | null>(null);
  const [mockupReady, setMockupReady] = useState(false);
  const [mockupError, setMockupError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadImage(mockupSrc)
      .then((img) => {
        const info = detectScreenInfo(img);
        setMockupImg(img);
        setScreenInfo(info);
        setMockupReady(true);
      })
      .catch(() => {
        setMockupError(true);
      });
  }, []);

  const processFiles = useCallback(
    async (files: File[]) => {
      if (!mockupImg || !screenInfo) return;
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      const newItems: ProcessedImage[] = imageFiles.map((file) => ({
        id: `${Date.now()}-${Math.random()}`,
        originalName: file.name,
        originalSrc: URL.createObjectURL(file),
        compositeSrc: null,
        status: "processing",
      }));

      setImages((prev) => [...newItems, ...prev]);

      for (const item of newItems) {
        try {
          const result = await compositeImage(item.originalSrc, mockupImg, screenInfo);
          setImages((prev) =>
            prev.map((img) =>
              img.id === item.id ? { ...img, compositeSrc: result, status: "done" } : img
            )
          );
        } catch {
          setImages((prev) =>
            prev.map((img) =>
              img.id === item.id ? { ...img, status: "error", errorMsg: "İşlem hatası" } : img
            )
          );
        }
      }
    },
    [mockupImg, screenInfo]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(Array.from(e.dataTransfer.files));
    },
    [processFiles]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      processFiles(Array.from(e.target.files || []));
      e.target.value = "";
    },
    [processFiles]
  );

  const handleClear = () => {
    images.forEach((img) => URL.revokeObjectURL(img.originalSrc));
    setImages([]);
  };

  const doneCount = images.filter((i) => i.status === "done").length;
  const processingCount = images.filter((i) => i.status === "processing").length;

  return (
    <div className="min-h-screen bg-[#0f0f13] text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-white/10 bg-[#16161d] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <rect x="5" y="2" width="14" height="20" rx="3" />
              <line x1="9" y1="6" x2="15" y2="6" />
              <line x1="9" y1="10" x2="15" y2="10" />
            </svg>
          </div>
          <div>
            <h1 className="text-white" style={{ fontSize: "1rem", lineHeight: "1.25" }}>MockupKit</h1>
            <p style={{ fontSize: "0.7rem", color: "#6b7280", lineHeight: "1.2" }}>iPhone 15 Pro Max Frame Generator</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {processingCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span style={{ fontSize: "0.75rem", color: "#fbbf24" }}>{processingCount} işleniyor</span>
            </div>
          )}
          {doneCount > 0 && (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <span style={{ fontSize: "0.75rem", color: "#34d399" }}>{doneCount} hazır</span>
              </div>
              <button
                onClick={() => downloadAll(images)}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 transition-colors"
                style={{ fontSize: "0.8rem" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7,10 12,15 17,10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Tümünü İndir
              </button>
              <button
                onClick={handleClear}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 hover:bg-white/5 transition-colors"
                style={{ fontSize: "0.8rem", color: "#9ca3af" }}
              >
                Temizle
              </button>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col p-6 gap-6">
        {mockupError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span style={{ fontSize: "0.85rem", color: "#f87171" }}>Mockup şablonu yüklenemedi. Lütfen sayfayı yenileyin.</span>
          </div>
        )}

        {/* Debug info when mockup is ready */}
        {mockupReady && screenInfo && (
          <div className="rounded-xl border border-white/8 bg-white/3 px-4 py-2.5 flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>Şablon hazır</span>
            </div>
            <span style={{ fontSize: "0.72rem", color: "#4b5563" }}>
              Ekran alanı: <span style={{ color: "#9ca3af" }}>{screenInfo.bounds.width} × {screenInfo.bounds.height} px</span>
            </span>
            <span style={{ fontSize: "0.72rem", color: "#4b5563" }}>
              Konum: <span style={{ color: "#9ca3af" }}>x={screenInfo.bounds.x}, y={screenInfo.bounds.y}</span>
            </span>
            <span style={{ fontSize: "0.72rem", color: "#4b5563" }}>
              Köşe yarıçapı: <span style={{ color: "#9ca3af" }}>{screenInfo.cornerRadius} px</span>
            </span>
          </div>
        )}

        {/* Upload Zone */}
        <div
          className={`relative rounded-2xl border-2 border-dashed transition-all cursor-pointer
            ${isDragging ? "border-violet-500 bg-violet-500/10" : "border-white/15 bg-white/3 hover:border-white/25 hover:bg-white/5"}
            ${!mockupReady ? "opacity-50 pointer-events-none" : ""}
          `}
          style={{ minHeight: "180px" }}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center justify-center p-10 gap-4">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-colors ${isDragging ? "bg-violet-500/25" : "bg-white/8"}`}>
              {mockupReady ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={isDragging ? "#a78bfa" : "#6b7280"} strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17,8 12,3 7,8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              ) : (
                <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              )}
            </div>
            <div className="text-center">
              <p style={{ fontSize: "1rem", color: isDragging ? "#a78bfa" : "#d1d5db", lineHeight: "1.5" }}>
                {mockupReady ? (isDragging ? "Görselleri bırakın..." : "Ekran görsellerini sürükleyip bırakın ya da tıklayın") : "Mockup şablonu yükleniyor..."}
              </p>
              {mockupReady && (
                <p style={{ fontSize: "0.8rem", color: "#6b7280", marginTop: "4px" }}>PNG, JPG, WEBP — aynı anda birden fazla dosya desteklenir</p>
              )}
            </div>
            {mockupReady && (
              <div className="flex items-center gap-4 flex-wrap justify-center">
                {[
                  "Oran korunur",
                  "Rounded clip uygulanır",
                  "Dynamic Island görünür",
                  "PNG çıktı",
                ].map((label) => (
                  <div key={label} className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/8">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5">
                      <polyline points="20,6 9,17 4,12" />
                    </svg>
                    <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>{label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
        </div>

        {/* Results Grid */}
        {images.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 style={{ fontSize: "0.9rem", color: "#d1d5db", lineHeight: "1.5" }}>
                Sonuçlar
                <span style={{ color: "#6b7280", marginLeft: "8px", fontWeight: 400 }}>{images.length} görsel</span>
              </h2>
            </div>
            <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
              {images.map((img) => (
                <MockupCard
                  key={img.id}
                  image={img}
                  onDownload={() => {
                    if (img.compositeSrc) downloadBlob(img.compositeSrc, img.originalName.replace(/\.[^/.]+$/, "") + "_mockup.png");
                  }}
                  onRemove={() => {
                    URL.revokeObjectURL(img.originalSrc);
                    setImages((prev) => prev.filter((i) => i.id !== img.id));
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {images.length === 0 && mockupReady && (
          <div className="flex-1 flex items-center justify-center">
            <MockupPreview />
          </div>
        )}
      </main>
    </div>
  );
}

function MockupCard({ image, onDownload, onRemove }: { image: ProcessedImage; onDownload: () => void; onRemove: () => void }) {
  return (
    <div className="group rounded-2xl border border-white/8 bg-white/4 overflow-hidden hover:border-white/15 transition-all">
      <div className="relative flex items-center justify-center bg-gradient-to-br from-[#1a1a24] to-[#12121a]" style={{ minHeight: "260px" }}>
        {image.status === "processing" && (
          <div className="flex flex-col items-center gap-3">
            <svg className="animate-spin w-10 h-10" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="16" stroke="#2d2d3a" strokeWidth="4" />
              <path d="M20 4 a16 16 0 0 1 16 16" stroke="#7c3aed" strokeWidth="4" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>İşleniyor...</span>
          </div>
        )}
        {image.status === "error" && (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span style={{ fontSize: "0.75rem", color: "#f87171" }}>{image.errorMsg || "Hata"}</span>
          </div>
        )}
        {image.status === "done" && image.compositeSrc && (
          <img src={image.compositeSrc} alt={image.originalName} style={{ maxWidth: "100%", maxHeight: "280px", objectFit: "contain", display: "block" }} />
        )}
        {image.status === "done" && (
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
            <button onClick={onDownload} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 transition-colors" style={{ fontSize: "0.78rem" }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7,10 12,15 17,10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              İndir
            </button>
            <button onClick={onRemove} className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/10 hover:bg-red-500/20 border border-transparent transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div className="px-3 py-2.5 border-t border-white/8">
        <p style={{ fontSize: "0.75rem", color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={image.originalName}>
          {image.originalName}
        </p>
        <div className="flex items-center justify-between mt-0.5">
          <span style={{ fontSize: "0.68rem" }} className={image.status === "done" ? "text-emerald-400" : image.status === "processing" ? "text-amber-400" : "text-red-400"}>
            {image.status === "done" ? "✓ Hazır" : image.status === "processing" ? "⟳ İşleniyor" : "✗ Hata"}
          </span>
          {image.status === "done" && (
            <button onClick={onDownload} style={{ fontSize: "0.68rem", color: "#7c3aed" }} className="hover:text-violet-400 transition-colors">
              PNG İndir →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MockupPreview() {
  return (
    <div className="flex flex-col items-center gap-6 opacity-40">
      <div className="relative rounded-[2.5rem] border-2 border-white/20 bg-gradient-to-b from-[#1e1e2a] to-[#16161f]" style={{ width: "120px", height: "240px" }}>
        <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-black border border-white/20" style={{ width: "36px", height: "10px" }} />
        <div className="absolute rounded-[1.5rem] bg-white/5 border border-white/8" style={{ top: "20px", left: "6px", right: "6px", bottom: "20px" }}>
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21,15 16,10 5,21" />
            </svg>
          </div>
        </div>
        <div className="absolute right-[-4px] rounded-r bg-white/20" style={{ top: "60px", width: "3px", height: "40px" }} />
        <div className="absolute left-[-4px] rounded-l bg-white/20" style={{ top: "50px", width: "3px", height: "22px" }} />
        <div className="absolute left-[-4px] rounded-l bg-white/20" style={{ top: "80px", width: "3px", height: "22px" }} />
      </div>
      <p style={{ fontSize: "0.85rem", color: "#6b7280", textAlign: "center" }}>Görsellerinizi yükleyin ve iPhone mockup'ı oluşturun</p>
    </div>
  );
}