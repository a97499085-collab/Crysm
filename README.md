# CRYSM

**WebGPU tabanlı, offline path tracing render motoru.** Blender Cycles'ın çalışma
mantığını (gerçek ışın izleme, çok sekmeli global aydınlatma, fiziksel materyaller)
tarayıcıda çalıştırır ve sabit **30 FPS** hedefiyle kilitlenir.

Rasterizer yok: her piksel için gerçek ışınlar atılır, BVH üzerinde sahnede
sekerek dolaşır, güneş ve alan ışığı için next-event estimation yapılır.

> Tek bir sahne (Atrium) içerir; amaç motorun kendisini göstermek.

---

## Hızlı başlangıç

```powershell
cd crysm
python -m http.server 5173 --bind 127.0.0.1
```

Sonra tarayıcıda:

```
http://127.0.0.1:5173/index.html
```

Gereksinim: WebGPU destekli tarayıcı — Chrome/Edge 113+, Safari 18+.
Windows'ta güncel GPU sürücüsü şart.

### URL parametreleri (test / demo)

| Parametre | Örnek | Açıklama |
|---|---|---|
| `scale` | `?scale=0.5` | Sabit iç çözünürlük ölçeği (adaptasyon kapanır) |
| `bounces` | `?bounces=3` | Yol sekmesi sayısı (1–8) |
| `fog` | `?fog=0` | Hacimsel sisi kapat |
| `taa` | `?taa=0` | Temporal AA'yı kapat (ham 1 spp) |
| `ao` | `?ao=1` | AO önizleme modu (1 sekme, sadece gökyüzü) |
| `ui` | `?ui=0` | Arayüzü gizle |
| `perf` | `?perf=1` | Zayıf GPU modunu zorla (test için) |
| `sun` / `sky` / `exposure` / `fogd` | `?sun=5&sky=0.8` | Aydınlatma ince ayarı |
| `sharp` | `?sharp=1.4` | HD keskinlik çarpanı (0–2, varsayılan 1.2) |

---

## Kontroller

| Girdi | İşlev |
|---|---|
| Sol sürükle | Yörünge |
| Tekerlek | Zoom |
| Sağ sürükle | Hedefi kaydır |
| `H` | Arayüzü gizle / göster |
| `R` | Kamerayı sıfırla |
| `P` | PNG kare kaydet |
| `Boşluk` | Otomatik yörünge |

Sağ üstteki panelden tüm özellikler canlı ayarlanır: sekme sayısı, güneş
şiddeti/açısı/yumuşaklığı, sis yoğunluğu, pozlama, bloom, film grain, hero
materyali...

---

## Özellikler (hepsi aktif)

| Özellik | Uygulama |
|---|---|
| **PBR Material System** | GGX specular + Lambert diffuse, metallic–roughness; pürüzsüz dielektrik cam (Fresnel + kırılma, IOR 1.52) |
| **Dynamic Shadows** | Güneş konisi üzerinden NEE; koni yarıçapı = yumuşak gölge. Işık açısı değişince gölgeler anında güncellenir |
| **Global Illumination** | Çok sekmeli yol izleme + Rus ruleti; renk taşınımı (kırmızı küp → zemin) gerçek |
| **Ambient Occlusion** | Yol izlemeli AO önizleme modu (1 sekme, gökyüzü ışığı) — SSAO hilesi değil |
| **Volumetric Fog** | Homojen katılımcı ortam, HG faz fonksiyonu, güneş yönünde gölgeli tek saçılma |
| **Bloom** | HDR üzerinden 5 seviyeli bright-pass + downsample zinciri |
| **HDR Rendering** | Tüm ara hedefler `rgba32float`, tonemap en sonda (ACES + sRGB) |
| **Temporal Anti-Aliasing** | Halton sub-pixel jitter + dünya konumundan reprojeksiyon + progressive accumulation (dururken sonsuz spp) |
| **WebGPU Backend** | Saf WebGPU compute + render pipeline, harici kütüphane yok |
| **HD Reconstruction** | Lanczos-2 uzaysal büyütme + kontrast-adaptif keskinleştirme (CAS). Düşük iç çözünürlükten keskin görüntü; film grain sonradan eklendiği için dokusu korunur |

Ek olarak: alan ışığı (ışık çubuğu) için dikdörtgen NEE, ateş böceği bastırma,
vinyet, dither'lı film grain, PNG export.

---

## 30 FPS kilidi nasıl çalışıyor

30 FPS **mutlak hedef** olduğu için motor, kaliteyi görüntüyü bozmadan
GPU'ya göre ayarlar:

1. **Frame pacer** — `requestAnimationFrame` üzerinde 33.3 ms kadans; erken
   gelen kareler atlanır.
2. **Tek kare uçuşta** — `queue.onSubmittedWorkDone()` beklenir, böylece GPU
   kuyruğu şişmez ve gecikme birikmez.
3. **Adaptif iç çözünürlük** — gerçek GPU süresi (`previewMs`) her karede
   ölçülür. Hedef 24–34 ms bandı:
   - Kare 90 ms'yi aşarsa **anında** ölçek düşürülür (donma engellenir).
   - 34 ms üstünde her 6 karede bir yumuşak iniş.
   - 24 ms altında, **sadece kamera dururken** kademeli yükseliş.
   - Taban: normal GPU'da 0.32, zayıf GPU'da 0.25.
4. **Zayıf GPU algılama** — Intel UHD/Iris, Vega, Mali/Adreno veya ≤6 mantıksal
   çekirdek görülürse başlangıç ölçeği 0.34'e çekilir ve canvas DPR'si 1.0 ile
   sınırlanır. Yani ilk karede tam çözünürlükte donma yaşanmaz; motor birkaç
   saniye içinde kendi kendine yükselir.
5. **Hareket optimizasyonu (zayıf GPU)** — kamera hareket ederken kısa süreliğine
   2 sekme + %80 iç çözünürlük kullanılır. Görüntü zaten reprojeksiyonla
   harmanlandığı için fark edilmez; kamera durunca **tam kalite** (ayarlanan
   sekme sayısı, tam ölçek) geri gelir ve birikim devam eder.
6. **Any-hit gölge ışınları** — gölge/occlusion ışınları en yakın çarpmayı
   aramaz, ilk engelde çıkar. Sonuç bit-bit aynı, maliyet daha düşük.
7. **Sıfır-görsel-etki kalanlar** — shader'lar tek pipeline, bloom mip'leri
   `rgba16float`, ışık NEE'leri sadece gerekli sekmelerde.
8. **HD reconstruction** — iç çözünürlük düşükken final kare ekranda
   **Lanczos-2 + CAS** ile keskinleştirilir; grain en sonda eklendiği için
   film dokusu aynen korunur. Paneldeki **HD keskinlik** kaydırıcısı ile
   ikiye kadar yükseltilebilir.

HUD'daki `LOCK` / `ADAPT` göstergesi o anki durumu söyler:

- **LOCK** → 28.5 FPS üzeri, kilit tutuyor.
- **ADAPT** → GPU yetişemiyor, motor çözünürlüğü düşürüyor.

> Dürüst not: Path tracing maliyeti GPU'ya bağlıdır. Bu motor 30 FPS'i
> **adaptif iç çözünürlük** ile garanti eder; çok zayıf donanımda görüntü
> 0.25 ölçeğe kadar yumuşar. Daha keskin bir kare istiyorsan panelden sekme
> sayısını 2'ye indirebilirsin — 30 FPS bandı içinde daha yüksek çözünürlük
> elde edersin. Görsel tasarım (sahne, materyaller, ışık, tonemap) sabittir.

---

## Mimari

```
crysm/
├─ index.html                     arayüz iskeleti
├─ css/style.css                  sinema temalı koyu arayüz
├─ src/main.js                    boot, pacer, adaptif kalite, input, PNG
├─ src/ui/hud.js                  ayar paneli + canlı istatistikler
└─ src/engine/
   ├─ math.js                     vektör/matris, Halton
   ├─ camera.js                   sönümlü yörünge kamerası
   ├─ scene/
   │  ├─ geometry.js              sphere/box/plane/torus/cylinder
   │  ├─ bvh.js                   CPU median-split BVH (32 B düğüm)
   │  └─ scene.js                 Atrium sahnesi + materyaller + alan ışığı
   ├─ webgpu/
   │  ├─ device.js                adaptör/cihaz/bağlam
   │  └─ renderer.js              render graph, uniform yazımı, PNG readback
   └─ shaders/
      ├─ pathtrace.wgsl           path tracer (BVH, BRDF, NEE, sis)
      ├─ taa.wgsl                 reprojeksiyon + birikim
      ├─ bloom.wgsl               bright pass + downsample
      └─ composite.wgsl           bloom, pozlama, ACES, sRGB, grain
```

Kare akışı:

```
pathtrace (compute) → TAA/accumulate (compute) → bloom ×5 (compute)
→ composite + ACES tonemap (render pass) → swapchain
```

Uniform yapısı dört WGSL dosyasında birebir aynıdır; kamera alanları 0–15,
güneş 16–23, gökyüzü 24–31, sis 32–35, render seçenekleri 36–39, çözünürlük
40–47, post 48–51, misc 52–55, önceki view-projection 56–71, alan ışığı 72–91.

---

## Geliştirici testleri

`.tools/cdp.mjs` headless Chrome + CDP ile sayfayı açar, konsol hatalarını
toplar, JS çalıştırır ve ekran görüntüsü alır:

```powershell
node .tools/cdp.mjs "http://127.0.0.1:5173/index.html?scale=0.4&ui=0" ".shots/test.png" 12000 "JSON.stringify(window.__crysm.stats)"
```

`window.__crysm` üzerinden `settings`, `camera`, `stats`, `renderer`,
`scene`, `saveFrame` erişilebilir.

## Bilinen sınırlar

- Tek gömülü sahne (Atrium); sahne yükleme/format desteği yok.
- Doku (albedo/normal/roughness map) desteği yok — materyaller prosedürel.
- Cam yüzeylerde bulanık (rough) kırılma yok; pürüzsüz dielektrik.
- Sis homojen (yükseklik dağılımı yok) ve tek saçılmalı.
- Performans GPU'ya bağlıdır; 30 FPS adaptif çözünürlükle korunur.
