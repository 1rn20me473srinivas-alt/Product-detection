// tools/generate-references.js
// Generates synthetic multi-angle reference images per product using Jimp

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const CATALOG_PATH = path.join(__dirname, '..', 'catalog', 'products.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'references');

const IMAGE_SIZE = 512;
const ANGLES = [0, 30, 60, 90, 120, 150, 180, 210]; // 8 angles

// Simple color map for demo to map catalog color names to RGB
const COLOR_MAP = {
  'white': [245,245,245],
  'silver': [192,192,192],
  'brown': [150,75,0],
  'dark brown': [90,50,20],
  'beige': [245,245,220],
  'green': [34,139,34],
  'blue': [30,144,255],
  'purple': [128,0,128],
  'golden': [212,175,55],
  'tan': [210,180,140],
  'black': [30,30,30],
  'crystal': [200,220,255],
  'emerald': [0,128,64],
  'pink': [255,192,203],
  'amber': [255,191,0]
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function mapColor(name) {
  if (!name) return [200,180,160];
  const k = name.toLowerCase();
  return COLOR_MAP[k] || [200,180,160];
}

async function drawProductImage(shape, colorRgb, angle, text) {
  const img = new Jimp(IMAGE_SIZE, IMAGE_SIZE, 0xffffffff);

  // background subtle gradient
  const bg = new Jimp(IMAGE_SIZE, IMAGE_SIZE, 0xffffffff);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    const t = y / IMAGE_SIZE;
    const r = Math.round(250 - 15 * t);
    const g = Math.round(250 - 20 * t);
    const b = Math.round(255 - 25 * t);
    const rowColor = Jimp.rgbaToInt(r, g, b, 255);
    for (let x = 0; x < IMAGE_SIZE; x++) bg.setPixelColor(rowColor, x, y);
  }
  img.composite(bg, 0, 0);

  // center coordinates
  const cx = IMAGE_SIZE / 2;
  const cy = IMAGE_SIZE / 2;

  // draw simplified product shape
  const shapeLayer = new Jimp(IMAGE_SIZE, IMAGE_SIZE, 0x00000000);
  const [r,g,b] = colorRgb;
  const fill = Jimp.rgbaToInt(r, g, b, 255);
  const outline = Jimp.rgbaToInt(Math.max(0,r-30), Math.max(0,g-30), Math.max(0,b-30), 255);

  if (shape === 'cylinder' || shape === 'cylinder-like' || shape === 'cylinder') {
    // draw ellipse to mimic mug/tumbler
    const rx = IMAGE_SIZE * 0.22;
    const ry = IMAGE_SIZE * 0.28;
    for (let y = -ry; y <= ry; y++) {
      for (let x = -rx; x <= rx; x++) {
        const vx = x;
        const vy = y;
        if ((vx*vx)/(rx*rx) + (vy*vy)/(ry*ry) <= 1) {
          const px = Math.round(cx + vx);
          const py = Math.round(cy + vy - 20);
          shapeLayer.setPixelColor(fill, px, py);
        }
      }
    }
    // handle - top shading
    const topEllipseRx = rx;
    const topEllipseRy = ry * 0.25;
    for (let y = -topEllipseRy; y <= topEllipseRy; y++) {
      for (let x = -topEllipseRx; x <= topEllipseRx; x++) {
        if ((x*x)/(topEllipseRx*topEllipseRx) + (y*y)/(topEllipseRy*topEllipseRy) <= 1) {
          const px = Math.round(cx + x);
          const py = Math.round(cy - ry - 18 + y);
          const prev = shapeLayer.getPixelColor(px, py);
          // lighten top to give highlight
          shapeLayer.setPixelColor(fill, px, py);
        }
      }
    }
  } else {
    // rectangular product (box)
    const w = IMAGE_SIZE * 0.48;
    const h = IMAGE_SIZE * 0.36;
    const left = Math.round(cx - w/2);
    const top = Math.round(cy - h/2 + 10);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = left + x;
        const py = top + y;
        shapeLayer.setPixelColor(fill, px, py);
      }
    }
    // add a darker band to simulate lid/edge
    const bandH = Math.round(h * 0.15);
    for (let y = 0; y < bandH; y++) {
      for (let x = 0; x < w; x++) {
        const px = left + x;
        const py = top + y;
        const cur = shapeLayer.getPixelColor(px, py);
        shapeLayer.setPixelColor(outline, px, py);
      }
    }
  }

  // apply rotation to simulate angle
  const rotated = shapeLayer.rotate(angle, false);
  img.composite(rotated, 0, 0);

  // small ambient shadow
  const shadow = new Jimp(IMAGE_SIZE, IMAGE_SIZE, 0x00000000);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      // simple radial falloff for shadow
      const dx = x - cx;
      const dy = y - (cy + IMAGE_SIZE * 0.18);
      const dist = Math.sqrt(dx*dx + dy*dy);
      const alpha = Math.max(0, 180 - dist/1.5);
      if (alpha > 0) {
        const c = Jimp.rgbaToInt(0,0,0, Math.round(alpha));
        shadow.setPixelColor(c, x, y);
      }
    }
  }
  img.composite(shadow, 0, 0);

  // apply minor blur and noise for realism
  img.blur(1);

  // add text label
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const textWidth = Jimp.measureText(font, text);
  img.print(font, Math.round((IMAGE_SIZE - textWidth)/2), IMAGE_SIZE - 80, text);

  // small vignette
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      const dx = (x - cx) / (IMAGE_SIZE/2);
      const dy = (y - cy) / (IMAGE_SIZE/2);
      const d = Math.sqrt(dx*dx + dy*dy);
      const dark = Math.max(0, Math.min(60, Math.round(60 * (d*d))));
      const idx = (y * IMAGE_SIZE + x) << 2;
      // read pixel
      const col = img.getPixelColor(x, y);
      const rgba = Jimp.intToRGBA(col);
      const nr = Math.max(0, rgba.r - dark);
      const ng = Math.max(0, rgba.g - dark);
      const nb = Math.max(0, rgba.b - dark);
      img.setPixelColor(Jimp.rgbaToInt(nr, ng, nb, rgba.a), x, y);
    }
  }

  return img;
}

async function generate() {
  ensureDir(OUTPUT_DIR);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  console.log(`Found ${catalog.length} products in catalog`);

  for (const product of catalog) {
    const pid = product.id || product.name.replace(/\s+/g,'_').toLowerCase();
    const outDir = path.join(OUTPUT_DIR, pid);
    ensureDir(outDir);

    const color = mapColor(product.color);
    const shape = (product.shape || 'rectangular').toLowerCase();
    const refs = [];

    for (let i = 0; i < ANGLES.length; i++) {
      const angle = ANGLES[i];
      const filename = `${pid}_angle_${angle}.jpg`;
      const outPath = path.join(outDir, filename);
      const text = `${product.name}`;
      try {
        const img = await drawProductImage(shape, color, angle, product.name);
        await img.quality(90).writeAsync(outPath);
        refs.push(path.relative(path.join(__dirname,'..'), outPath).replace(/\\/g,'/'));
      } catch (err) {
        console.error('Error writing image for', pid, angle, err);
      }
    }

    // update product with references array
    product.references = refs;
    console.log(`Generated ${refs.length} references for ${pid}`);
  }

  // write updated catalog (backup existing)
  const backupPath = CATALOG_PATH + '.bak';
  fs.copyFileSync(CATALOG_PATH, backupPath);
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf8');
  console.log('Updated catalog written with references, backup saved to', backupPath);
}

if (require.main === module) {
  generate().then(() => {
    console.log('Reference generation complete');
  }).catch(err => {
    console.error('Generation failed', err);
  });
}
