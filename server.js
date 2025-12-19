const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const OpenVINODetector = require('./openvino-detector');

const app = express();
const PORT = process.env.PORT || 3000;
const STUB_MODE = process.env.STUB_MODE === '1';

// OpenVINO detector instance
let ovDetector = null;
let ovAvailable = false;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Upload configuration
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Product database (loaded from catalog)
let productDB = [];
// Reference signatures loaded from `references/` or `catalog[].references`
const referenceSignatures = {}; // productId -> [{ path, ahash, hist }]
// Product zones (ROIs) for person-gated detection
let productZones = [];

// Helper: bbox overlap ratio
function computeOverlap(a, b) {
  if (!a || !b) return 0;
  const ax1 = a.x, ay1 = a.y, ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx1 = b.x, by1 = b.y, bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const aarea = a.width * a.height;
  const barea = b.width * b.height;
  const denom = Math.max(aarea + barea - inter, 1e-6);
  // Use intersection over union
  return inter / denom;
}

// Helpers for signatures
function xorCount(a, b) {
  // a,b are binary strings of equal length
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) c++;
  return c;
}

async function computeAHashFromJimp(image) {
  // average hash (aHash) 8x8
  const small = image.clone().resize(8, 8).greyscale();
  const data = small.bitmap.data;
  let sum = 0;
  const vals = [];
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    vals.push(v);
    sum += v;
  }
  const avg = sum / vals.length;
  let hash = '';
  for (const v of vals) hash += (v >= avg) ? '1' : '0';
  return hash; // 64-char string
}

// Synchronous version for OpenVINO integration
function computeAHashSync(image) {
  const small = image.clone().resize(8, 8).greyscale();
  const data = small.bitmap.data;
  let sum = 0;
  const vals = [];
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    vals.push(v);
    sum += v;
  }
  const avg = sum / vals.length;
  let hash = '';
  for (const v of vals) hash += (v >= avg) ? '1' : '0';
  return hash;
}

// pHash - More robust to lighting and minor angle changes
async function computePHashFromJimp(image) {
  const size = 32;
  const small = image.clone().resize(size, size).greyscale();
  const data = small.bitmap.data;
  
  // Extract luminance values
  const vals = [];
  for (let i = 0; i < data.length; i += 4) {
    vals.push(data[i]);
  }
  
  // Simple DCT-like transform (use median instead of full DCT for performance)
  const median = vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  let hash = '';
  for (const v of vals) {
    hash += (v >= median) ? '1' : '0';
  }
  return hash.substring(0, 64); // 64-bit hash
}

// Structural similarity for shapes
async function computeStructuralHash(image) {
  const small = image.clone().resize(16, 16).greyscale();
  const data = small.bitmap.data;
  
  // Extract edge patterns
  const edges = [];
  for (let y = 1; y < 15; y++) {
    for (let x = 1; x < 15; x++) {
      const idx = (y * 16 + x) * 4;
      const center = data[idx];
      const top = data[((y-1) * 16 + x) * 4];
      const bottom = data[((y+1) * 16 + x) * 4];
      const left = data[(y * 16 + (x-1)) * 4];
      const right = data[(y * 16 + (x+1)) * 4];
      
      const gradient = Math.abs(center - top) + Math.abs(center - bottom) + 
                      Math.abs(center - left) + Math.abs(center - right);
      edges.push(gradient);
    }
  }
  
  const median = edges.slice().sort((a, b) => a - b)[Math.floor(edges.length / 2)];
  let hash = '';
  for (const e of edges) {
    hash += (e >= median) ? '1' : '0';
  }
  return hash.substring(0, 64);
}

function computeColorHistogramFromJimp(image) {
  // simple 4x4x4 quantized histogram -> 64 bins
  const small = image.clone().resize(64, 64);
  const data = small.bitmap.data;
  const bins = new Array(64).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const ri = Math.floor(r / 64);
    const gi = Math.floor(g / 64);
    const bi = Math.floor(b / 64);
    const idx = ri * 16 + gi * 4 + bi;
    bins[idx]++;
  }
  const total = bins.reduce((s, v) => s + v, 0) || 1;
  return bins.map(v => v / total);
}

function histIntersection(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.min(a[i], b[i]);
  return sum; // 0..1
}

// Human detection: detect skin tones and human-like features WITH BOUNDING BOX
function detectHuman(image) {
  const data = image.bitmap.data;
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  
  let skinPixels = 0;
  let totalPixels = 0;
  let faceRegionPixels = 0;
  
  // Track bounding box of skin pixels
  let minX = w, maxX = 0, minY = h, maxY = 0;
  
  // Skin tone detection ranges (RGB)
  const skinRanges = [
    { rMin: 95, rMax: 255, gMin: 40, gMax: 170, bMin: 20, bMax: 130 },   // Light to medium skin
    { rMin: 45, rMax: 100, gMin: 28, gMax: 65, bMin: 20, bMax: 55 }      // Darker skin tones
  ];
  
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) << 2;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      
      totalPixels++;
      
      // Check if pixel matches skin tone ranges
      let isSkin = false;
      for (const range of skinRanges) {
        if (r >= range.rMin && r <= range.rMax &&
            g >= range.gMin && g <= range.gMax &&
            b >= range.bMin && b <= range.bMax) {
          if (r > g && g >= b) {
            isSkin = true;
            break;
          }
        }
      }
      
      if (isSkin) {
        skinPixels++;
        // Update bounding box
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        
        if (y < h / 3) {
          faceRegionPixels++;
        }
      }
    }
  }
  
  const skinRatio = skinPixels / totalPixels;
  const faceRegionRatio = faceRegionPixels / (totalPixels / 3);
  const isHuman = skinRatio > 0.08 || faceRegionRatio > 0.15;
  
  // DEBUG: Always log detection status
  console.log(`👤 Human Detection: skinRatio=${(skinRatio*100).toFixed(1)}%, faceRegion=${(faceRegionRatio*100).toFixed(1)}%, isHuman=${isHuman}`);
  
  // Calculate normalized bounding box
  let boundingBox = { x: 0.15, y: 0.1, width: 0.7, height: 0.8 }; // default
  
  if (isHuman && skinPixels > 0) {
    // Add padding (10% on each side)
    const padding = 0.1;
    const boxW = maxX - minX;
    const boxH = maxY - minY;
    
    minX = Math.max(0, minX - boxW * padding);
    maxX = Math.min(w, maxX + boxW * padding);
    minY = Math.max(0, minY - boxH * padding);
    maxY = Math.min(h, maxY + boxH * padding);
    
    boundingBox = {
      x: minX / w,
      y: minY / h,
      width: (maxX - minX) / w,
      height: (maxY - minY) / h
    };
  }
  
  return {
    isHuman,
    skinRatio: Number(skinRatio.toFixed(3)),
    faceRegionRatio: Number(faceRegionRatio.toFixed(3)),
    boundingBox
  };
}

// Helper: Check if pixel is skin tone
function isSkinTone(r, g, b) {
  const skinRanges = [
    { rMin: 95, rMax: 255, gMin: 40, gMax: 100, bMin: 20, bMax: 85 },
    { rMin: 80, rMax: 220, gMin: 50, gMax: 150, bMin: 30, bMax: 100 },
    { rMin: 150, rMax: 255, gMin: 100, gMax: 200, bMin: 80, bMax: 150 }
  ];
  
  for (const range of skinRanges) {
    if (r >= range.rMin && r <= range.rMax &&
        g >= range.gMin && g <= range.gMax &&
        b >= range.bMin && b <= range.bMax) {
      if (r > g && g >= b) {
        return true;
      }
    }
  }
  return false;
}

// Detect product location in image - EXCLUDE person body, focus on held objects
function detectProductLocation(image, excludeHumanBox = null) {
  const data = image.bitmap.data;
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  
  // Create edge map
  const edges = new Array(w * h).fill(0);
  
  // CRITICAL: Only scan lower 60% of frame where hands hold products (exclude head/upper body)
  const startY = Math.floor(h * 0.4);
  
  for (let y = Math.max(1, startY); y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) << 2;
      
      // Simple Sobel-like edge detection - NO FILTERING
      let gx = 0, gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const pidx = ((y + dy) * w + (x + dx)) << 2;
          const intensity = (data[pidx] + data[pidx + 1] + data[pidx + 2]) / 3;
          gx += intensity * dx;
          gy += intensity * dy;
        }
      }
      
      edges[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  
  // Find regions with high edge density (potential products)
  const gridSize = 16; // divide image into grid
  const gridW = Math.ceil(w / gridSize);
  const gridH = Math.ceil(h / gridSize);
  const gridScores = [];
  
  const startGridY = Math.floor((h * 0.4) / gridSize);
  
  for (let gy = startGridY; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      let edgeSum = 0;
      let count = 0;
      
      for (let y = gy * gridSize; y < Math.min((gy + 1) * gridSize, h); y++) {
        for (let x = gx * gridSize; x < Math.min((gx + 1) * gridSize, w); x++) {
          // Skip if in human box
          if (excludeHumanBox) {
            const normX = x / w;
            const normY = y / h;
            if (normX >= excludeHumanBox.x && normX <= excludeHumanBox.x + excludeHumanBox.width &&
                normY >= excludeHumanBox.y && normY <= excludeHumanBox.y + excludeHumanBox.height) {
              continue;
            }
          }
          
          edgeSum += edges[y * w + x];
          count++;
        }
      }
      
      // Accept any region with edges - NO FILTERING
      if (count > 0 && edgeSum > 0) {
        gridScores.push({
          x: gx * gridSize,
          y: gy * gridSize,
          score: edgeSum / count,
          gx, gy
        });
      }
    }
  }
  
  // Find top region (product likely location)
  gridScores.sort((a, b) => b.score - a.score);
  
  if (gridScores.length === 0) {
    return { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }; // default center box
  }
  
  // Take top region and expand to neighboring high-score regions
  const topRegion = gridScores[0];
  let minGx = topRegion.gx, maxGx = topRegion.gx;
  let minGy = topRegion.gy, maxGy = topRegion.gy;
  
  // Include adjacent high-score regions (>50% of top score)
  const threshold = topRegion.score * 0.5;
  for (const region of gridScores.slice(1, 10)) {
    if (region.score < threshold) break;
    
    if (Math.abs(region.gx - topRegion.gx) <= 2 && Math.abs(region.gy - topRegion.gy) <= 2) {
      minGx = Math.min(minGx, region.gx);
      maxGx = Math.max(maxGx, region.gx);
      minGy = Math.min(minGy, region.gy);
      maxGy = Math.max(maxGy, region.gy);
    }
  }
  
  // Convert to normalized coordinates with padding
  const padding = 0.05;
  const x = Math.max(0, (minGx * gridSize) / w - padding);
  const y = Math.max(0, (minGy * gridSize) / h - padding);
  const width = Math.min(1 - x, ((maxGx + 1) * gridSize) / w - x + padding);
  const height = Math.min(1 - y, ((maxGy + 1) * gridSize) / h - y + padding);
  
  return { x, y, width, height };
}

// SEMANTIC FEATURE DETECTION - Detect object-specific features
function detectSemanticFeatures(image) {
  const data = image.bitmap.data;
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const features = {};
  
  // 1. SCREEN DETECTION - Look for bright rectangular region (smartphone, smartwatch)
  features.hasScreen = detectScreen(image);
  
  // 2. CIRCULAR ELEMENTS - Cameras, lenses, bottle caps, buttons
  features.circularElements = detectCircularElements(image);
  
  // 3. REFLECTIVITY - Glossy surfaces (glass, metal, plastic)
  features.reflectivity = detectReflectivity(image);
  
  // 4. METALLIC SURFACE - Brushed/polished metal
  features.isMetallic = detectMetallicSurface(image);
  
  // 5. TRANSPARENT/GLASS - Bottles, glasses
  features.hasTransparency = detectTransparency(image);
  
  // 6. TEXT/LABELS - Packaging with visible text
  features.hasText = detectTextRegions(image);
  
  // 7. UNIFORM COLOR REGIONS - Solid color products
  features.uniformity = detectColorUniformity(image);
  
  // 8. MULTI-COMPARTMENT - Lunch boxes, cases
  features.hasCompartments = detectCompartments(image);
  
  return features;
}

// Detect screen presence (bright rectangular region)
function detectScreen(image) {
  const data = image.bitmap.data;
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  
  let brightPixels = 0;
  let totalPixels = w * h;
  
  // Check for concentrated brightness in center region
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y++) {
    for (let x = Math.floor(w * 0.2); x < w * 0.8; x++) {
      const idx = (y * w + x) * 4;
      const avg = (data[idx] + data[idx+1] + data[idx+2]) / 3;
      if (avg > 180) brightPixels++; // Bright pixel threshold
    }
  }
  
  const brightRatio = brightPixels / (totalPixels * 0.36); // 0.36 = center region
  return brightRatio > 0.15; // 15% of center is bright
}

// Detect circular elements using edge detection
function detectCircularElements(image) {
  const gray = image.clone().greyscale();
  const data = gray.bitmap.data;
  const w = gray.bitmap.width;
  const h = gray.bitmap.height;
  
  let circularScore = 0;
  const samplePoints = 20;
  
  // Sample random points and check for circular patterns
  for (let i = 0; i < samplePoints; i++) {
    const cx = Math.floor(Math.random() * (w - 20) + 10);
    const cy = Math.floor(Math.random() * (h - 20) + 10);
    
    // Check if edges form circular pattern at this point
    let edgeCount = 0;
    for (let r = 3; r < 10; r++) {
      for (let theta = 0; theta < 360; theta += 45) {
        const rad = theta * Math.PI / 180;
        const px = Math.floor(cx + r * Math.cos(rad));
        const py = Math.floor(cy + r * Math.sin(rad));
        
        if (px >= 0 && px < w && py >= 0 && py < h) {
          const idx = (py * w + px) * 4;
          const curr = data[idx];
          const center = data[(cy * w + cx) * 4];
          if (Math.abs(curr - center) > 30) edgeCount++;
        }
      }
    }
    if (edgeCount > 20) circularScore++;
  }
  
  return circularScore / samplePoints;
}

// Detect reflective/glossy surfaces
function detectReflectivity(image) {
  const data = image.bitmap.data;
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  
  let highlights = 0;
  let shadows = 0;
  let totalPixels = w * h;
  
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i+1] + data[i+2]) / 3;
    if (avg > 220) highlights++; // Very bright spots
    if (avg < 40) shadows++; // Dark areas
  }
  
  const contrast = (highlights + shadows) / totalPixels;
  return contrast > 0.05; // High contrast indicates glossy surface
}

// Detect metallic surfaces (brushed/polished metal)
function detectMetallicSurface(image) {
  const data = image.bitmap.data;
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  
  let metallicPixels = 0;
  let totalPixels = w * h;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i+1];
    const b = data[i+2];
    
    // Metallic colors: silver/gray with low saturation
    const avg = (r + g + b) / 3;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    
    if (avg > 100 && avg < 220 && saturation < 30) {
      metallicPixels++;
    }
  }
  
  return (metallicPixels / totalPixels) > 0.30; // 30% metallic-looking
}

// Detect transparency/glass
function detectTransparency(image) {
  const data = image.bitmap.data;
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  
  // Look for edges with background bleed-through
  let transparentRegions = 0;
  
  for (let y = 10; y < h - 10; y += 5) {
    for (let x = 10; x < w - 10; x += 5) {
      const idx = (y * w + x) * 4;
      const r = data[idx];
      const g = data[idx+1];
      const b = data[idx+2];
      
      // Check neighbors for color variation (background visible through object)
      const idx2 = ((y+5) * w + (x+5)) * 4;
      const r2 = data[idx2];
      const g2 = data[idx2+1];
      const b2 = data[idx2+2];
      
      const diff = Math.abs(r-r2) + Math.abs(g-g2) + Math.abs(b-b2);
      if (diff > 50 && diff < 150) transparentRegions++;
    }
  }
  
  return transparentRegions > 10;
}

// Detect text regions (packaging labels)
function detectTextRegions(image) {
  const gray = image.clone().greyscale();
  const data = gray.bitmap.data;
  const w = gray.bitmap.width;
  const h = gray.bitmap.height;
  
  let edgePatterns = 0;
  
  // Look for horizontal/vertical line patterns typical of text
  for (let y = 5; y < h - 5; y += 3) {
    let horizontalEdges = 0;
    for (let x = 5; x < w - 5; x++) {
      const idx = (y * w + x) * 4;
      const curr = data[idx];
      const left = data[(y * w + (x-1)) * 4];
      const right = data[(y * w + (x+1)) * 4];
      
      if (Math.abs(curr - left) > 40 || Math.abs(curr - right) > 40) {
        horizontalEdges++;
      }
    }
    if (horizontalEdges > w * 0.1) edgePatterns++;
  }
  
  return edgePatterns > 5;
}

// Detect color uniformity
function detectColorUniformity(image) {
  const data = image.bitmap.data;
  let rSum = 0, gSum = 0, bSum = 0;
  let totalPixels = data.length / 4;
  
  for (let i = 0; i < data.length; i += 4) {
    rSum += data[i];
    gSum += data[i+1];
    bSum += data[i+2];
  }
  
  const avgR = rSum / totalPixels;
  const avgG = gSum / totalPixels;
  const avgB = bSum / totalPixels;
  
  let variance = 0;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - avgR;
    const dg = data[i+1] - avgG;
    const db = data[i+2] - avgB;
    variance += (dr*dr + dg*dg + db*db);
  }
  
  variance /= totalPixels;
  return 1 - Math.min(variance / 10000, 1); // Normalize to 0-1
}

// Detect compartments (lunch boxes, cases)
function detectCompartments(image) {
  const edges = image.clone().greyscale();
  const data = edges.bitmap.data;
  const w = edges.bitmap.width;
  const h = edges.bitmap.height;
  
  let gridLines = 0;
  
  // Look for internal dividing lines
  for (let y = Math.floor(h * 0.3); y < h * 0.7; y += 10) {
    let verticalLine = 0;
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      const top = data[((y-1) * w + x) * 4];
      const bottom = data[((y+1) * w + x) * 4];
      if (Math.abs(data[idx] - top) > 50 && Math.abs(data[idx] - bottom) > 50) {
        verticalLine++;
      }
    }
    if (verticalLine > w * 0.4) gridLines++;
  }
  
  return gridLines > 1;
}

async function loadReferenceSignatures() {
  // Build reference signatures from productDB references array or from references/<productId>/ folder
  console.log('  Loading reference signatures...');
  for (const p of productDB) {
    const pid = p.id || p.name.replace(/\s+/g, '_').toLowerCase();
    console.log(`  Processing product: ${pid}`);
    const refs = p.references && p.references.length ? p.references : [];
    const list = [];
    // if references empty, check folder
    if (refs.length === 0) {
      const dir = path.join(__dirname, 'references', pid);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => /\.jpe?g|\.png$/i.test(f));
        for (const f of files) refs.push(path.join('references', pid, f));
        console.log(`  Found ${files.length} reference images in folder`);
      }
    }

    for (const rel of refs) {
      try {
        const refPath = path.isAbsolute(rel) ? rel : path.join(__dirname, rel);
        if (!fs.existsSync(refPath)) continue;
        console.log(`    Loading ${path.basename(refPath)}...`);
        const img = await Jimp.read(refPath);
        const ahash = await computeAHashFromJimp(img);
        const phash = await computePHashFromJimp(img);
        const shash = await computeStructuralHash(img);
        const hist = computeColorHistogramFromJimp(img);
        list.push({ path: refPath, ahash, phash, shash, hist });
      } catch (err) {
        console.warn('Could not load reference', rel, err.message);
      }
    }

    if (list.length) referenceSignatures[pid] = list;
  }
  console.log('✓ Loaded reference signatures for', Object.keys(referenceSignatures).length, 'products');
}

// Load product zones (ROIs)
function loadProductZones() {
  try {
    const zonesPath = path.join(__dirname, 'config', 'zones.json');
    if (!fs.existsSync(zonesPath)) {
      console.warn('⚠️  No zones.json found, proximity gating disabled');
      return;
    }
    
    const rawData = fs.readFileSync(zonesPath, 'utf8');
    productZones = JSON.parse(rawData);
    console.log(`✅ Loaded ${productZones.length} product zones:`);
    productZones.forEach(z => console.log(`   - ${z.productId}: ${z.name} (${z.x},${z.y} ${z.width}x${z.height})`));
  } catch (err) {
    console.error('❌ Error loading zones:', err.message);
  }
}

// Check if person is in any product zone
function checkPersonInZone(personBox) {
  if (!personBox || !productZones.length) return { inZone: false };
  
  const personCenterX = personBox.x + (personBox.width / 2);
  const personCenterY = personBox.y + (personBox.height / 2);
  
  let nearestZone = null;
  let minDistance = Infinity;
  
  for (const zone of productZones) {
    const zoneCenterX = zone.x + (zone.width / 2);
    const zoneCenterY = zone.y + (zone.height / 2);
    
    const distance = Math.sqrt(
      Math.pow(personCenterX - zoneCenterX, 2) + 
      Math.pow(personCenterY - zoneCenterY, 2)
    );
    
    // Check if person overlaps zone or is within proximity threshold
    const overlapsX = personCenterX >= zone.x && personCenterX <= (zone.x + zone.width);
    const overlapsY = personCenterY >= zone.y && personCenterY <= (zone.y + zone.height);
    const withinThreshold = distance <= (zone.proximityThreshold || 100);
    
    if ((overlapsX && overlapsY) || withinThreshold) {
      if (distance < minDistance) {
        minDistance = distance;
        nearestZone = zone;
      }
    }
  }
  
  if (nearestZone) {
    return {
      inZone: true,
      productId: nearestZone.productId,
      zoneName: nearestZone.name,
      distance: Math.round(minDistance)
    };
  }
  
  return { inZone: false };
}

// Load product catalog
function loadProductCatalog() {
  try {
    const catalogPath = path.join(__dirname, 'catalog', 'products.json');
    console.log(`📂 Loading catalog from: ${catalogPath}`);
    
    if (!fs.existsSync(catalogPath)) {
      throw new Error('Catalog file not found');
    }
    
    const rawData = fs.readFileSync(catalogPath, 'utf8');
    productDB = JSON.parse(rawData);
    console.log(`✅ Loaded ${productDB.length} products from catalog:`);
    productDB.forEach(p => console.log(`   - ${p.id}: ${p.name} ($${p.price})`));
  } catch (err) {
    console.error('❌ Error loading product catalog:', err.message);
    console.log('⚠️  Using default fallback products instead');
    productDB = [
      {
        id: 'p1',
        name: 'Coffee Mug',
        category: 'Beverages',
        type: 'Ceramic Mug',
        price: 12.99,
        characteristics: ['ceramic', 'cylindrical', 'handle'],
        shape: 'cylinder',
        size: 'medium',
        color: 'white',
        texture: 'smooth',
        packaging: 'box',
        uniqueFeatures: ['dishwasher safe', 'heat resistant'],
        location: 'aisle-5'
      },
      {
        id: 'p2',
        name: 'Protein Shake',
        category: 'Beverages',
        type: 'Protein Drink',
        price: 8.99,
        characteristics: ['bottle', 'liquid', 'plastic'],
        shape: 'rectangular',
        size: 'small',
        color: 'brown',
        texture: 'glossy',
        packaging: 'plastic bottle',
        uniqueFeatures: ['high protein', 'low sugar'],
        location: 'aisle-3'
      },
      {
        id: 'p3',
        name: 'Chocolate Bar',
        category: 'Snacks',
        type: 'Candy',
        price: 2.99,
        characteristics: ['rectangular', 'wrapped', 'foil'],
        shape: 'rectangular',
        size: 'small',
        color: 'brown',
        texture: 'ridged',
        packaging: 'foil wrapper',
        uniqueFeatures: ['70% cocoa', 'organic'],
        location: 'aisle-4'
      }
    ];
  }
}

// Generate mock inference response
/**
 * Analyze image and attempt to match a product from the catalog.
 * Uses Jimp to compute a simple edge-density heuristic and color/aspect heuristics
 * Prioritizes accuracy: if no clear product evidence is found, returns empty detections.
 */
async function analyzeImageAndDetect(filePath, filename, options = {}) {
  try {
    const image = await Jimp.read(filePath);

    // Resize for FAST processing - prioritize speed
    const W = 450; // Increased for better detail at distance
    const H = Jimp.AUTO;
    image.resize(W, H);

    // HUMAN DETECTION: Check if frame contains a human
    const humanCheck = detectHuman(image);
    
    const detections = [];
    const humans = [];
    let humanBox = null;
    
    // If human detected, add to humans array with ACTUAL bounding box
    if (humanCheck.isHuman) {
      humanBox = humanCheck.boundingBox;
      humans.push({
        type: 'human',
        confidence: Number(humanCheck.skinRatio.toFixed(3)),
        boundingBox: humanBox
      });
    }

    // Stub mode: if enabled and expected product is provided, short-circuit with a high-confidence match
    if (STUB_MODE && options.expectedProductId) {
      const stubProduct = productDB.find(p => p.id === options.expectedProductId);
      if (stubProduct) {
        console.log(`🧪 STUB MODE: forcing match to ${stubProduct.id}`);
        return {
          success: true,
          filename,
          timestamp: new Date().toISOString(),
          humans,
          detections: [
            {
              id: stubProduct.id,
              type: stubProduct.name,
              category: stubProduct.category,
              confidence: 0.95,
              price: stubProduct.price,
              characteristics: stubProduct.characteristics,
              shape: stubProduct.shape,
              size: stubProduct.size,
              color: stubProduct.color,
              texture: stubProduct.texture,
              packaging: stubProduct.packaging,
              uniqueFeatures: stubProduct.uniqueFeatures,
              location: stubProduct.location,
              // Simple centered box to visualize detection
              boundingBox: { x: 0.25, y: 0.2, width: 0.5, height: 0.6 }
            }
          ]
        };
      }
    }

    // Try OpenVINO detection first if available
    if (ovAvailable && ovDetector) {
      try {
        console.log('🔍 Running OpenVINO object detection...');
        const ovDetections = await ovDetector.detect(filePath);
        
        if (ovDetections && ovDetections.length > 0) {
          console.log(`  OpenVINO detected ${ovDetections.length} objects`);
          
          // Filter for relevant objects (cell phone, bottle, etc.)
          const relevantClasses = {
            'cell phone': ['p5'], // Smartphone
            'bottle': ['p4', 'p6'], // Water Bottle, Perfume
            'backpack': ['p1'], // Could be yoga mat bag
            'sports ball': ['p1'], // Possible yoga mat rolled up
            'wine glass': ['p6'], // Perfume bottle shape
            'cup': ['p4'] // Water bottle
          };
          
          for (const det of ovDetections) {
            const possibleProducts = relevantClasses[det.className] || [];
            
            if (possibleProducts.length > 0) {
              console.log(`  → ${det.className} detected (${(det.confidence * 100).toFixed(1)}%), matching against: ${possibleProducts.join(', ')}`);
              
              // For each possible product, use reference matching to find best match
              let bestMatch = null;
              let bestScore = 0;
              
              for (const prodId of possibleProducts) {
                const product = productDB.find(p => p.id === prodId);
                if (!product) continue;
                
                // Use reference matching to verify
                const refs = referenceSignatures[prodId] || [];
                if (refs.length === 0) continue;
                
                const refScores = refs.map(ref => {
                  const ahashSim = 1 - (xorCount(ref.ahash, computeAHashSync(image)) / ref.ahash.length);
                  return ahashSim;
                });
                
                const avgRefScore = refScores.reduce((a, b) => a + b, 0) / refScores.length;
                const combinedScore = det.confidence * 0.4 + avgRefScore * 0.6;
                
                if (combinedScore > bestScore) {
                  bestScore = combinedScore;
                  bestMatch = product;
                }
              }
              
              if (bestMatch && bestScore >= 0.70) {
                console.log(`✅ OpenVINO + Reference Match: ${bestMatch.name} (${(bestScore * 100).toFixed(1)}%)`);
                
                // Add detection with OpenVINO bounding box
                detections.push({
                  id: bestMatch.id,
                  type: bestMatch.name,
                  category: bestMatch.category,
                  confidence: bestScore,
                  price: bestMatch.price,
                  characteristics: bestMatch.characteristics,
                  shape: bestMatch.shape,
                  size: bestMatch.size,
                  color: bestMatch.color,
                  texture: bestMatch.texture,
                  packaging: bestMatch.packaging,
                  uniqueFeatures: bestMatch.uniqueFeatures,
                  location: bestMatch.location,
                  boundingBox: {
                    x: det.x / image.bitmap.width,
                    y: det.y / image.bitmap.height,
                    width: det.width / image.bitmap.width,
                    height: det.height / image.bitmap.height
                  },
                  method: 'OpenVINO'
                });
              }
            }
          }
          
          // If OpenVINO found a match, return early
          if (detections.length > 0) {
            return {
              success: true,
              filename,
              timestamp: new Date().toISOString(),
              humans,
              detections
            };
          }
        }
        
        console.log('  OpenVINO: No relevant objects detected, falling back to heuristics');
      } catch (err) {
        console.warn('⚠️  OpenVINO detection failed, using heuristics:', err.message);
      }
    }

    // Compute edge-like response using simple convolution (Sobel-ish)
    const gx = [
      [-1, 0, 1],
      [-2, 0, 2],
      [-1, 0, 1]
    ];
    const gy = [
      [-1, -2, -1],
      [0, 0, 0],
      [1, 2, 1]
    ];

    const gray = image.clone().greyscale();
    const w = gray.bitmap.width;
    const h = gray.bitmap.height;
    const data = gray.bitmap.data;

    let edgeSum = 0;
    let sampleCount = 0;

    // Sample pixels to keep compute reasonable
    const step = Math.max(1, Math.floor(w * h / 8000));

    for (let y = 1; y < h - 1; y += step) {
      for (let x = 1; x < w - 1; x += step) {
        let sumX = 0;
        let sumY = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const px = x + kx;
            const py = y + ky;
            const idx = (py * w + px) << 2;
            const lum = data[idx]; // greyscale -> R==G==B
            sumX += gx[ky + 1][kx + 1] * lum;
            sumY += gy[ky + 1][kx + 1] * lum;
          }
        }
        const mag = Math.sqrt(sumX * sumX + sumY * sumY);
        edgeSum += mag;
        sampleCount++;
      }
    }

    const edgeMean = sampleCount > 0 ? edgeSum / sampleCount : 0;

    // Compute aspect ratio
    const aspectRatio = w / h;

    // Average color (on original resized image)
    const rgbImg = image.clone();
    let rSum = 0, gSum = 0, bSum = 0, pxCount = 0;
    const rgbData = rgbImg.bitmap.data;
    for (let i = 0; i < rgbData.length; i += 4) {
      rSum += rgbData[i];
      gSum += rgbData[i + 1];
      bSum += rgbData[i + 2];
      pxCount++;
    }
    const avgR = rSum / pxCount;
    const avgG = gSum / pxCount;
    const avgB = bSum / pxCount;

    // Heuristic thresholds: require clear product evidence
    // Low threshold - focus on detecting products, not filtering noise
    const EDGE_THRESHOLD = 5; // Very permissive - detect any product
    
    // DEBUG: Log edge detection
    console.log(`📊 Edge Detection: edgeMean=${edgeMean.toFixed(2)} (threshold=${EDGE_THRESHOLD})`);

    // If edgeMean is extremely low, likely empty frame or pure background -> return no detections
    if (edgeMean < EDGE_THRESHOLD) {
      const base = {
        success: true,
        filename: filename,
        timestamp: new Date().toISOString(),
        detections: []
      };
      if (options.debug) {
        base.diagnostics = {
          edgeMean: Number(edgeMean.toFixed(2)),
          aspectRatio: Number(aspectRatio.toFixed(3)),
          avgColor: { r: Math.round(avgR), g: Math.round(avgG), b: Math.round(avgB) },
          reason: 'edgeMean below threshold'
        };
      }
      return base;
    }

    console.log('✅ Proceeding with product detection');

    // Product detection - no size limits, detect anything

    // If we have edges, attempt a conservative match to catalog based on shape (aspect) and color
    // Map aspect ratio to shape preference
    const inferredShape = (function(ar) {
      if (ar > 1.35) return 'rectangular';
      if (ar < 0.75) return 'rectangular';
      return 'cylinder'; // treat near-square as cylindrical/round
    })(aspectRatio);

    // NEW ALGORITHM: Prioritize shape, size, edges, and texture over color
    // Compute MULTIPLE reference signatures for multi-angle matching
    const uploadedAhash = await computeAHashFromJimp(image);
    const uploadedPhash = await computePHashFromJimp(image);
    const uploadedShash = await computeStructuralHash(image);
    const uploadedHist = computeColorHistogramFromJimp(image);

    // Compute texture features (edge variance)
    const textureScore = edgeMean / 30; // Normalize edge density as texture indicator
    
    // ENABLE ALL SEMANTIC FEATURES - Critical for accurate detection
    const detectedFeatures = {
      hasScreen: detectScreen(image),
      circularElements: detectCircularElements(image),
      reflectivity: detectReflectivity(image),
      isMetallic: detectMetallicSurface(image),
      hasTransparency: detectTransparency(image),
      hasText: detectTextRegions(image),
      uniformity: detectColorUniformity(image),
      hasCompartments: detectCompartments(image)
    };

    console.log('🔍 Detected Features:', detectedFeatures);

    // Compare products: PRIORITIZE shape (50%), size (25%), texture (15%), color only (10%)
    let best = null;
    let bestScore = 0;
    const diagnostics = [];
    for (const p of productDB) {
      let heuristicScore = 0;
      
      // 1. SHAPE MATCHING (50% weight) - Most important
      let shapeScore = 0;
      if (p.shape) {
        const pShape = p.shape.toLowerCase();
        // Exact shape match
        if (pShape === inferredShape) {
          shapeScore = 1.0;
        } else if ((pShape === 'rectangular' && Math.abs(aspectRatio - 1.0) > 0.5) ||
                   (pShape === 'cylinder' && Math.abs(aspectRatio - 1.0) <= 0.5)) {
          shapeScore = 0.7; // Partial shape match
        } else {
          shapeScore = 0.3; // Different shape
        }
      }
      heuristicScore += 0.50 * shapeScore;
      
      // 2. SIZE MATCHING (25% weight) - Second most important
      let sizeScore = 0.5; // Default neutral
      if (p.size) {
        const pSize = p.size.toLowerCase();
        // Estimate size from image dimensions and aspect ratio
        const imageArea = w * h;
        if (pSize === 'small' && imageArea < 200000) sizeScore = 1.0;
        else if (pSize === 'medium' && imageArea >= 150000 && imageArea <= 300000) sizeScore = 1.0;
        else if (pSize === 'large' && imageArea > 250000) sizeScore = 1.0;
        else sizeScore = 0.4; // Size mismatch penalty
      }
      heuristicScore += 0.25 * sizeScore;
      
      // 3. TEXTURE/EDGE MATCHING (15% weight) - Packaging and surface details
      let edgeMatchScore = 0.5;
      if (p.texture) {
        const pTexture = p.texture.toLowerCase();
        if ((pTexture.includes('smooth') || pTexture.includes('glossy')) && textureScore < 0.5) {
          edgeMatchScore = 0.8;
        } else if ((pTexture.includes('ridged') || pTexture.includes('textured')) && textureScore > 0.6) {
          edgeMatchScore = 0.9;
        }
      }
      heuristicScore += 0.15 * edgeMatchScore;
      
      // 4. COLOR (10% weight) - Least important, only as tiebreaker
      let colorScore = 0.5; // Neutral default
      if (p.color) {
        const colorName = p.color.toLowerCase();
        const colorMap = {
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
          'black': [30,30,30]
        };
        const target = colorMap[colorName] || [200, 180, 160];
        const dr = avgR - target[0];
        const dg = avgG - target[1];
        const db = avgB - target[2];
        const dist = Math.sqrt(dr*dr + dg*dg + db*db) / 441.67;
        colorScore = Math.max(0, 1 - dist);
      }
      heuristicScore += 0.10 * colorScore;
      
      // 5. SEMANTIC FEATURE MATCHING (30% weight) - NEW! Object-specific features
      let featureMatchScore = 0;
      if (p.detectableFeatures) {
        const expected = p.detectableFeatures;
        const detected = detectedFeatures;
        let matches = 0;
        let total = 0;
        
        // Screen detection (critical for phones/watches)
        if (expected.hasScreen !== undefined) {
          total++;
          if (expected.hasScreen === detected.hasScreen) matches += 1.5; // Extra weight
        }
        
        // Circular elements (cameras, caps, lenses)
        if (expected.circularElements !== undefined) {
          total++;
          const diff = Math.abs(expected.circularElements - detected.circularElements);
          matches += Math.max(0, 1 - diff);
        }
        
        // Reflectivity
        if (expected.reflectivity !== undefined) {
          total++;
          if (expected.reflectivity === detected.reflectivity) matches++;
        }
        
        // Metallic surface
        if (expected.isMetallic !== undefined) {
          total++;
          if (expected.isMetallic === detected.isMetallic) matches++;
        }
        
        // Transparency/glass
        if (expected.hasTransparency !== undefined) {
          total++;
          if (expected.hasTransparency === detected.hasTransparency) matches++;
        }
        
        // Text/labels
        if (expected.hasText !== undefined) {
          total++;
          if (expected.hasText === detected.hasText) matches++;
        }
        
        // Compartments
        if (expected.hasCompartments !== undefined) {
          total++;
          if (expected.hasCompartments === detected.hasCompartments) matches++;
        }
        
        featureMatchScore = total > 0 ? matches / total : 0;
      }
      
      // Recalculate weights: Shape (35%), Features (30%), Size (20%), Texture (10%), Color (5%)
      heuristicScore = 0.35 * shapeScore + 0.30 * featureMatchScore + 0.20 * sizeScore + 
                       0.10 * edgeMatchScore + 0.05 * colorScore;

      // Reference matching score (if references exist) - MULTI-HASH for better angle handling
      let refBestScore = 0;
      const pid = p.id || p.name.replace(/\s+/g, '_').toLowerCase();
      const refs = referenceSignatures[pid];
      if (refs && refs.length) {
        for (const r of refs) {
          // aHash - basic similarity
          const aHashDist = xorCount(uploadedAhash, r.ahash);
          const aHashSim = 1 - (aHashDist / uploadedAhash.length);
          
          // pHash - better for lighting/angle changes
          const pHashDist = xorCount(uploadedPhash, r.phash);
          const pHashSim = 1 - (pHashDist / uploadedPhash.length);
          
          // Structural hash - best for shape matching
          const sHashDist = xorCount(uploadedShash, r.shash);
          const sHashSim = 1 - (sHashDist / uploadedShash.length);
          
          // Color histogram - reduced weight
          const histSim = histIntersection(uploadedHist, r.hist);
          
          // WEIGHTED COMBO: Structure (40%), pHash (35%), aHash (15%), Color (10%)
          const rscore = 0.40 * sHashSim + 0.35 * pHashSim + 0.15 * aHashSim + 0.10 * histSim;
          if (rscore > refBestScore) refBestScore = rscore;
        }
      }

      // Combine refBestScore and heuristicScore - VERY STRICT VALIDATION
      // Reference matching is CRITICAL - without good reference match, reject detection
      let finalScore = 0;
      
      // CRITICAL: If semantic features strongly mismatch, reject even high ref scores
      const hasStrongFeatureMismatch = (
        (p.detectableFeatures?.hasScreen && !detectedFeatures.hasScreen) ||
        (!p.detectableFeatures?.hasScreen && detectedFeatures.hasScreen)
      );
      
      // NEW: Require minimum reference score to prevent random pattern matching
      const MIN_REF_SCORE = 0.60; // Must have at least 60% reference similarity
      
      if (hasStrongFeatureMismatch) {
        // Screen presence is a deal-breaker - reduce reference weight drastically
        finalScore = 0.15 * refBestScore + 0.85 * heuristicScore;
        console.log(`⚠️  ${p.id}: Screen mismatch! Ref=${refBestScore.toFixed(2)}, Heuristic=${heuristicScore.toFixed(2)}, Final=${finalScore.toFixed(2)}`);
      } else if (refBestScore < MIN_REF_SCORE) {
        // Reference too weak - likely random pattern/noise, heavily penalize
        finalScore = 0.10 * refBestScore + 0.90 * heuristicScore;
        if (finalScore > 0.50) {
          console.log(`⚠️  ${p.id}: Weak reference (${(refBestScore*100).toFixed(1)}%) - likely false positive`);
          finalScore *= 0.60; // Apply 40% penalty
        }
      } else if (refBestScore > 0.85 && heuristicScore > 0.40) {
        // Strong ref match AND reasonable heuristic - HIGHEST PRIORITY
        finalScore = 0.85 * refBestScore + 0.15 * heuristicScore; // Trust reference images heavily
      } else if (refBestScore > 0.70 && heuristicScore > 0.30) {
        // Good ref match with decent heuristic - favor references
        finalScore = 0.75 * refBestScore + 0.25 * heuristicScore;
      } else if (refBestScore > MIN_REF_SCORE) {
        // Moderate ref match - still favor references
        finalScore = 0.65 * refBestScore + 0.35 * heuristicScore;
      } else {
        // Should not reach here due to MIN_REF_SCORE check above
        finalScore = heuristicScore * 0.5; // Heavy penalty for no references
      }

      if (finalScore > bestScore) {
        bestScore = finalScore;
        best = { product: p, refScore: refBestScore, heuristicScore: heuristicScore };
      }

      // push diagnostics for this product
      diagnostics.push({
        id: p.id,
        name: p.name,
        shape: p.shape,
        size: p.size,
        shapeMatch: Number(shapeScore?.toFixed(3) || 0),
        sizeMatch: Number(sizeScore?.toFixed(3) || 0),
        featureMatch: Number(featureMatchScore?.toFixed(3) || 0),
        heuristicScore: Number(heuristicScore.toFixed(4)),
        refBestScore: Number(refBestScore.toFixed(4)),
        finalScore: Number(finalScore.toFixed(4))
      });
    }

    // Confidence threshold: 75% to prevent false positives
    // Requires both good reference match AND reasonable heuristics
    const confidence = Math.min(0.99, bestScore);
    const bp = best?.product;
    const expectedProductId = options.expectedProductId;
    
    // Sort diagnostics by score for logging
    diagnostics.sort((a, b) => b.finalScore - a.finalScore);
    
    // Always log top 3 candidates for debugging
    console.log('\n🏆 Top 3 Detection Candidates:');
    diagnostics.slice(0, 3).forEach((d, i) => {
      console.log(`  ${i+1}. ${d.name} (${d.id}): Final=${(d.finalScore*100).toFixed(1)}% [Heuristic=${(d.heuristicScore*100).toFixed(1)}% Ref=${(d.refBestScore*100).toFixed(1)}%]`);
      console.log(`     Shape=${(d.shapeMatch*100).toFixed(0)}% Features=${(d.featureMatch*100).toFixed(0)}% Size=${(d.sizeMatch*100).toFixed(0)}%`);
    });
    console.log(`\n🎯 Best score: ${(bestScore*100).toFixed(1)}% (threshold: 75%)`);

    // Ambiguity check: ensure margin between top-1 and top-2
    const top1 = diagnostics[0]?.finalScore || 0;
    const top2 = diagnostics[1]?.finalScore || 0;
    const margin = top1 - top2;
    const MIN_MARGIN = 0.08; // 8% required separation
    
    // Shared response for any rejection scenario (low confidence, empty frame)
    const noMatchResponse = {
      success: true,
      filename: filename,
      timestamp: new Date().toISOString(),
      humans: humans, // Still return person box even if no product detected
      detections: [],
      message: 'no product detected'
    };

    // Reject if:
    // 1. No match found
    // 2. Confidence below 75%
    // 3. Very low edge detection (empty frame)
    // 4. Ambiguous candidates (margin too small)
    if (!best || confidence < 0.75 || edgeMean < 4 || margin < MIN_MARGIN) {
      const base = {
        success: true,
        filename: filename,
        timestamp: new Date().toISOString(),
        humans: humans, // Still return person box even if no product detected
        detections: [],
        message: "no product detected"
      };
      if (options.debug) {
        base.diagnostics = {
          reason: !best ? 'no match' : (confidence < 0.75 ? 'low confidence' : (margin < MIN_MARGIN ? 'ambiguous candidates' : 'empty frame')),
          bestScore: bestScore.toFixed(3),
          edgeMean: edgeMean.toFixed(2),
          margin: Number(margin.toFixed(3)),
          topMatches: diagnostics.slice(0, 3)
        };
      }
      const reason = !best ? 'no match' : (confidence < 0.75 ? `low confidence (${(confidence*100).toFixed(1)}%)` : (margin < MIN_MARGIN ? `ambiguous (margin ${(margin*100).toFixed(1)}%)` : `low edges (${edgeMean.toFixed(1)})`));
      console.log(`❌ No product detected: ${reason}`);
      return base;
    }

    // Zone enforcement disabled for single-box mode
    // Products are matched purely on confidence without zone restrictions
    
    console.log('✅ Detected:', bp.name, '- Confidence:', (confidence * 100).toFixed(1) + '%');
    
    // Calculate product bounding box (SEPARATE from person)
    const productBox = detectProductLocation(image, humanBox);

    // Optional: If we detected a human, require product near hands region
    // Skip this check if no human detected (e.g., reference images of products alone)
    if (humanBox && productBox) {
      // Define hands area as lower 30% of human bounding box
      const handsArea = {
        x: humanBox.x,
        y: humanBox.y + (humanBox.height * 0.70),
        width: humanBox.width,
        height: humanBox.height * 0.30
      };
      const overlap = computeOverlap(productBox, handsArea);
      const MIN_HAND_OVERLAP = 0.15; // at least 15% overlap
      if (overlap < MIN_HAND_OVERLAP) {
        console.log(`⚠️  Product not near hands (overlap ${(overlap*100).toFixed(1)}%), rejecting`);
        return {
          success: true,
          filename: filename,
          timestamp: new Date().toISOString(),
          humans,
          detections: [],
          message: 'no product detected'
        };
      } else {
        console.log(`✓ Product near hands (overlap ${(overlap*100).toFixed(1)}%)`);
      }
    } else if (!humanBox && productBox) {
      console.log('ℹ No human detected, allowing product match (reference-only image)');
    }
    
    const result = {
      success: true,
      filename: filename,
      timestamp: new Date().toISOString(),
      humans: humans, // Person bounding box (if detected)
      detections: [
        {
          id: bp.id,
          type: bp.name,
          category: bp.category,
          confidence: parseFloat(confidence.toFixed(3)),
          price: bp.price,
          characteristics: bp.characteristics,
          shape: bp.shape,
          size: bp.size,
          color: bp.color,
          texture: bp.texture,
          packaging: bp.packaging,
          uniqueFeatures: bp.uniqueFeatures,
          location: bp.location,
          boundingBox: productBox // Product box ONLY (excludes person)
        }
      ]
    };
    if (options.debug) result.diagnostics = diagnostics;
    return result;
  } catch (err) {
    console.error('analyzeImageAndDetect error:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

// Page Routes
app.get('/v2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index2.html'));
});

// API Routes
app.get('/api/catalog', (req, res) => {
  res.json({
    success: true,
    total: productDB.length,
    products: productDB
  });
});

app.get('/api/zones', (req, res) => {
  res.json({
    success: true,
    total: productZones.length,
    zones: productZones
  });
});

app.post('/api/check-proximity', express.json(), (req, res) => {
  try {
    const { personBox } = req.body;
    if (!personBox) {
      return res.status(400).json({ success: false, error: 'No person box provided' });
    }
    
    const proximityResult = checkPersonInZone(personBox);
    res.json({
      success: true,
      ...proximityResult
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/detect', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image provided' });
  }

  // Optional zone gating: expected product for the active zone
  const expectedProductId = req.body?.zoneProductId || req.body?.expectedProductId;

  console.log(`🔍 Received image: ${req.file.filename}`);

  // Simulate processing time
  // Prioritize accuracy: perform image analysis (may take longer)
  // Prioritize accuracy: perform image analysis (may take longer)
  (async () => {
    try {
      const debug = req.query && req.query.debug === '1';
      const response = await analyzeImageAndDetect(req.file.path, req.file.filename, { debug, expectedProductId });
      if (response.detections && response.detections.length) {
        console.log(`✓ Detection result: ${response.detections[0].type} (${(response.detections[0].confidence * 100).toFixed(1)}%)`);
      } else {
        console.log('ℹ No product detected in image');
      }
      // Return result
      res.json(response);
    } catch (err) {
      console.error('Detection error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  })();
});

// New endpoint for base64 image upload (from frontend)
app.post('/detect', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    if (!req.body.image) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'No image data provided' 
      });
    }

    console.log('🖼️ Received base64 image from', req.body.source || 'unknown source');

    // Convert base64 to buffer
    const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Save temporarily
    const tempFilename = `upload-${Date.now()}.jpg`;
    const tempPath = path.join('uploads', tempFilename);
    fs.writeFileSync(tempPath, buffer);

    // Analyze the image (optional expected product for zone-based uploads)
    const expectedProductId = req.body?.zoneProductId || req.body?.expectedProductId;
    const response = await analyzeImageAndDetect(tempPath, tempFilename, { debug: false, expectedProductId });

    // Clean up temp file
    fs.unlinkSync(tempPath);

    // Format response for frontend
    if (response.detections && response.detections.length > 0) {
      const detection = response.detections[0];
      const product = productDB.find(p => p.id === detection.id);
      
      if (!product) {
        console.error(`❌ Product not found in DB for ID: ${detection.id}`);
        return res.json({
          status: 'no_product_detected',
          message: 'Product matched but not found in catalog'
        });
      }
      
      res.json({
        status: 'success',
        product: product,
        confidence: detection.confidence,
        boundingBox: detection.boundingBox,
        processingTime: response.processingTime || 0
      });
      
      console.log(`✅ Uploaded image matched: ${product.name} (${(detection.confidence * 100).toFixed(1)}%)`);
    } else {
      res.json({
        status: 'no_product_detected',
        message: response.message || 'No matching product detected'
      });
      console.log('⚠️ No product detected in uploaded image');
    }

  } catch (err) {
    console.error('Upload detection error:', err);
    res.status(500).json({ 
      status: 'error', 
      message: err.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Edge Insights Demo' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, error: err.message });
});

// Server startup (ensure product catalog & reference signatures are loaded first)
(async () => {
  try {
    console.log('Starting server initialization...');
    loadProductCatalog();
    console.log('Catalog loaded successfully');
    loadProductZones();
    console.log('Zones loaded successfully');
    await loadReferenceSignatures();
    console.log('Reference signatures loaded successfully');
    
    // Initialize OpenVINO detector
    console.log('\n🔧 Initializing OpenVINO...');
    try {
      ovDetector = new OpenVINODetector(path.join(__dirname, 'models'));
      ovAvailable = await ovDetector.initialize();
      
      if (!ovAvailable) {
        console.log('⚠️  OpenVINO initialization failed, using heuristics only\n');
      }
    } catch (err) {
      console.warn('⚠️  OpenVINO not available:', err.message);
      console.log('   Continuing with heuristic detection only\n');
      ovAvailable = false;
    }
    
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════╗
║  Intel Edge Insights Product Recognition Demo     ║
║  🌐 Server running on http://localhost:${PORT}       ║
║  📦 Open browser and navigate to root URL          ║
╚════════════════════════════════════════════════════╝
  `);
      if (STUB_MODE) {
        console.log('⚙️  STUB_MODE=ON (forcing expectedProductId matches when provided)');
      }
      console.log(`🤖 Detection: ${ovAvailable ? 'OpenVINO + Heuristic Fallback' : 'Heuristic Only'}\n`);
    });
  } catch (err) {
    console.error('Startup error:', err);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
})();
