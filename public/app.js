// Intel Edge Insights Demo - Frontend Application
// Handles camera capture, image upload, and product detection

// DOM Elements
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const overlayCanvas = document.createElement('canvas'); // overlay for bounding boxes
const overlayCtx = overlayCanvas.getContext('2d');
const btnStart = document.getElementById('btnStart');
const btnCapture = document.getElementById('btnCapture');
const btnStop = document.getElementById('btnStop');
const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');
const resultsEl = document.getElementById('results');
const catalogEl = document.getElementById('catalog');
const btnLoadCatalog = document.getElementById('btnLoadCatalog');
const autoScanEl = document.getElementById('autoScan');
const cameraStatusEl = document.getElementById('camera-status');

// State
let stream = null;
let autoScan = false;
let scanInterval = null;
let detectionHistory = [];
let totalResponseTime = 0;
let previousFrame = null;
let motionStabilityCount = 0;
const motionStabilityRequired = 1; // require 1 frame of motion
const detectionCooldown = 1500; // ms between detection requests
let lastDetectionTime = 0;

// Product tracking to avoid re-scanning same products
let trackedProducts = []; // [{ id, signature, bbox, lastSeen }]
let currentFrameSignature = null;

// Initialize overlay canvas after DOM is ready
function initOverlayCanvas() {
  const cameraContainer = document.querySelector('.camera-container');
  if (cameraContainer && !cameraContainer.contains(overlayCanvas)) {
    cameraContainer.appendChild(overlayCanvas);
    overlayCanvas.style.position = 'absolute';
    overlayCanvas.style.top = '0';
    overlayCanvas.style.left = '0';
    overlayCanvas.style.pointerEvents = 'none';
    overlayCanvas.style.zIndex = '10';
    console.log('✅ Overlay canvas initialized');
  }
}

// Event Listeners
btnStart.addEventListener('click', startCamera);
btnCapture.addEventListener('click', captureAndDetect);
btnStop.addEventListener('click', stopCamera);
autoScanEl.addEventListener('change', toggleAutoScan);
btnLoadCatalog.addEventListener('click', loadCatalog);
autoScanEl.addEventListener('change', toggleAutoScan);

// Drag and drop for upload
uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    processImage(files[0]);
  }
});

// Camera Functions
async function startCamera() {
  try {
    // Check if getUserMedia is supported
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Camera API not supported in this browser. Please use Chrome, Edge, or Firefox on HTTPS or localhost.');
      return;
    }

    // Try to get camera with fallback to any available camera
    let constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Fallback: try without facingMode constraint
      console.warn('Environment camera not available, trying default camera:', err);
      constraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }

    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
      console.log(`📷 Camera started: ${video.videoWidth}x${video.videoHeight}`);
      initOverlayCanvas(); // Initialize overlay when camera is ready
    });

    btnStart.disabled = true;
    btnCapture.disabled = false;
    btnStop.disabled = false;
    cameraStatusEl.textContent = 'Live';
    cameraStatusEl.classList.add('active');

    if (autoScanEl.checked) {
      startAutoScan();
    }
  } catch (err) {
    console.error('Camera access error:', err);
    let errorMsg = 'Could not access camera: ' + err.message;
    
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      errorMsg = '❌ Camera permission denied. Please allow camera access in your browser settings.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      errorMsg = '❌ No camera found. Please connect a camera and try again.';
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      errorMsg = '❌ Camera is already in use by another application.';
    } else if (err.name === 'SecurityError') {
      errorMsg = '❌ Camera access requires HTTPS or localhost. Current URL: ' + window.location.href;
    }
    
    alert(errorMsg);
    cameraStatusEl.textContent = 'Error';
    cameraStatusEl.classList.add('error');
    
    // Show instructions
    resultsEl.innerHTML = `
      <div class="placeholder" style="background: #ffebee; border: 2px solid #f44336; padding: 20px; border-radius: 8px;">
        <p style="font-size: 1.2em; font-weight: 600; color: #c62828; margin-bottom: 12px;">📷 Camera Access Issue</p>
        <p style="color: #c62828; margin-bottom: 8px;">${errorMsg}</p>
        <div style="margin-top: 16px; text-align: left; color: #c62828;">
          <p style="font-weight: 600; margin-bottom: 8px;">Troubleshooting:</p>
          <ul style="margin-left: 20px;">
            <li>Ensure you're accessing via <strong>http://localhost:3000</strong></li>
            <li>Click the camera icon in your browser's address bar to allow access</li>
            <li>Close other apps that might be using the camera</li>
            <li>Try refreshing the page and clicking "Start Camera" again</li>
            <li>Or use the "Upload Image" option below to test with files</li>
          </ul>
        </div>
      </div>
    `;
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  video.srcObject = null;
  btnStart.disabled = false;
  btnCapture.disabled = true;
  btnStop.disabled = true;
  cameraStatusEl.textContent = 'Ready';
  cameraStatusEl.classList.remove('active', 'error');
  autoScanEl.checked = false;
  stopAutoScan();
}

function captureAndDetect() {
  if (!stream) {
    alert('❌ Camera not started');
    return;
  }
  
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  
  canvas.width = w;
  canvas.height = h;
  
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  
  canvas.toBlob((blob) => {
    sendDetectionRequest(blob, 'capture.jpg');
  }, 'image/jpeg', 0.95);
}

// Auto-Scan Functions
function toggleAutoScan() {
  autoScan = autoScanEl.checked;
  
  if (autoScan && stream) {
    startAutoScan();
  } else {
    stopAutoScan();
  }
}

function startAutoScan() {
  if (!stream) return;
  
  stopAutoScan(); // Clear any existing interval
  
  // Smart scanning: detect motion AND check if product changed
  scanInterval = setInterval(() => {
    if (!video.videoWidth || !video.videoHeight) return;

    const w = video.videoWidth;
    const h = video.videoHeight;

    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const hasMotion = detectMotion(imageData.data, w, h);

    if (hasMotion) {
      // Check if frame content changed (new product appeared)
      const newSignature = computeFrameSignature(imageData.data, w, h);
      const frameChanged = !signaturesMatch(currentFrameSignature, newSignature);
      
      if (frameChanged) {
        currentFrameSignature = newSignature;
        
        const now = Date.now();
        if (now - lastDetectionTime < detectionCooldown) return;
        lastDetectionTime = now;

        console.log('📸 New product detected - scanning frame...');
        
        // Use higher quality for product recognition
        canvas.toBlob((blob) => {
          sendDetectionRequest(blob, 'autoscan.jpg');
        }, 'image/jpeg', 0.95);
      } else {
        console.log('👁️ Product moving - tracking without re-scan');
        // Product is just moving - update bounding boxes without full detection
        updateTrackingBoxes();
      }
    }
  }, 500); // check twice per second
}

function stopAutoScan() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}

// Update tracked product boxes when products move (without re-scanning)
function updateTrackingBoxes() {
  // If we have last detection data, keep showing those boxes
  // The boxes are already being drawn by drawBoundingBoxes
  // This is a placeholder for more advanced optical flow tracking in future
}

// Image processing removed - camera only mode

// API Communication
async function sendDetectionRequest(fileOrBlob, filename = 'image.jpg') {
  const form = new FormData();
  form.append('image', fileOrBlob, filename);
  
  try {
    const startTime = Date.now();
    cameraStatusEl.textContent = 'Detecting...';
    
    const response = await fetch('/api/detect', {
      method: 'POST',
      body: form
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const responseTime = Date.now() - startTime;
    
    // Draw bounding boxes on live camera feed OR uploaded image
    if (stream) {
      drawBoundingBoxes(data);
    } else {
      // For uploaded images, draw on upload canvas
      drawBoundingBoxes(data, true);
    }
    
    cameraStatusEl.textContent = 'Done';
    cameraStatusEl.classList.add('active');
    setTimeout(() => {
      if (stream) {
        cameraStatusEl.textContent = 'Live';
      }
    }, 1000);
    
    displayDetectionResults(data, responseTime);
    updateStats(data, responseTime);
  } catch (err) {
    console.error('Detection error:', err);
    cameraStatusEl.textContent = 'Error';
    cameraStatusEl.classList.add('error');
    resultsEl.innerHTML = `<div class="placeholder"><p>❌ Detection failed: ${err.message}</p></div>`;
  }
}

// Draw bounding boxes on camera overlay
function drawBoundingBoxes(data, isUpload = false) {
  let targetCanvas, targetCtx, w, h;
  
  if (isUpload) {
    // For uploaded images, use upload canvas
    targetCanvas = document.getElementById('uploadCanvas');
    if (!targetCanvas) return; // Canvas not ready yet
    targetCtx = targetCanvas.getContext('2d');
    w = targetCanvas.width;
    h = targetCanvas.height;
  } else {
    // For live camera, use overlay canvas
    targetCanvas = overlayCanvas;
    targetCtx = overlayCtx;
    targetCanvas.width = video.videoWidth;
    targetCanvas.height = video.videoHeight;
    targetCanvas.style.width = video.offsetWidth + 'px';
    targetCanvas.style.height = video.offsetHeight + 'px';
    w = targetCanvas.width;
    h = targetCanvas.height;
  }
  
  // Clear previous boxes
  targetCtx.clearRect(0, 0, w, h);
  
  // Draw humans (red boxes)
  if (data.humans && data.humans.length > 0) {
    targetCtx.strokeStyle = '#ff0000';
    targetCtx.lineWidth = 4;
    targetCtx.font = 'bold 20px Arial';
    targetCtx.fillStyle = '#ff0000';
    
    data.humans.forEach((human, idx) => {
      const bbox = human.boundingBox;
      const x = bbox.x * w;
      const y = bbox.y * h;
      const width = bbox.width * w;
      const height = bbox.height * h;
      
      targetCtx.strokeRect(x, y, width, height);
      targetCtx.fillText(`👤 HUMAN`, x + 10, y + 30);
    });
  }
  
  // Draw products (green boxes)
  if (data.detections && data.detections.length > 0) {
    targetCtx.lineWidth = 4;
    targetCtx.font = 'bold 18px Arial';
    
    data.detections.forEach((product, idx) => {
      const bbox = product.boundingBox;
      const x = bbox.x * w;
      const y = bbox.y * h;
      const width = bbox.width * w;
      const height = bbox.height * h;
      
      // Product box in green
      targetCtx.strokeStyle = '#00ff00';
      targetCtx.fillStyle = '#00ff00';
      targetCtx.strokeRect(x, y, width, height);
      
      // Product label
      const label = `${product.id}: ${product.type}`;
      const confidence = `${(product.confidence * 100).toFixed(1)}%`;
      
      // Background for text
      targetCtx.fillStyle = 'rgba(0, 255, 0, 0.8)';
      targetCtx.fillRect(x, y - 50, Math.max(200, targetCtx.measureText(label).width + 20), 50);
      
      // Text
      targetCtx.fillStyle = '#000000';
      targetCtx.fillText(label, x + 10, y - 25);
      targetCtx.fillText(confidence, x + 10, y - 5);
    });
  }
  
  // Auto-clear boxes after 3 seconds if not in auto-scan mode
  if (!autoScan) {
    setTimeout(() => {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }, 3000);
  }
}

// Display Results
function displayDetectionResults(data, responseTime) {
  if (!data || !data.success) {
    resultsEl.innerHTML = `<div class="placeholder"><p>❌ Detection error: ${data && data.error ? data.error : 'Unknown'}</p></div>`;
    return;
  }

  if (!data.detections || data.detections.length === 0) {
    // Check if humans detected but no products
    if (data.humans && data.humans.length > 0) {
      resultsEl.innerHTML = `
        <div class="placeholder" style="background: #e3f2fd; border: 2px solid #2196f3; padding: 20px; border-radius: 8px;">
          <p style="font-size: 1.2em; font-weight: 600; color: #1565c0; margin-bottom: 8px;">👤 ${data.humans.length} Human(s) Detected</p>
          <p class="small" style="color: #1565c0;">Please hold product clearly in view, separate from body.</p>
        </div>
      `;
      return;
    }
    
    // No detections - show strict "no product detected" message
    resultsEl.innerHTML = `
      <div class="placeholder" style="background: #f5f5f5; border: 2px solid #9e9e9e; padding: 24px; border-radius: 8px; text-align: center;">
        <p style="font-size: 1.5em; font-weight: 700; color: #424242; margin-bottom: 12px;">📭 no product detected</p>
        <p class="small" style="color: #757575; line-height: 1.6;">
          • Ensure a catalog product is clearly visible<br>
          • Hold product centered in camera view<br>
          • Avoid clutter, backgrounds, or random objects<br>
          • Detection requires ≥80% confidence
        </p>
      </div>
    `;
    return;
  }

  const detections = data.detections;
  let html = '';

  // Show human detection notice if present
  if (data.humans && data.humans.length > 0) {
    html += `
      <div style="background: #e8f5e9; border-left: 4px solid #4caf50; padding: 12px; margin-bottom: 16px; border-radius: 4px;">
        <p style="margin: 0; color: #2e7d32; font-weight: 600;">✅ ${data.humans.length} Human(s) + ${detections.length} Product(s) Detected</p>
      </div>
    `;
  }

  detections.forEach((detection, idx) => {
    const confidence = detection.confidence * 100;
    let confidenceClass = 'high';
    
    // Strict thresholds: high (80%+), medium (70-80%), low (<70%)
    if (confidence < 70) confidenceClass = 'low';
    else if (confidence < 80) confidenceClass = 'medium';
    else confidenceClass = 'high'; // 80%+ is high confidence

    const detectionCard = document.createElement('div');
    detectionCard.className = `detection-card ${confidenceClass}-confidence`;
    detectionCard.innerHTML = `
      <div class="detection-header">
        <div class="detection-title">
          ${detection.type}
          <span style="font-size: 0.8em; color: var(--text-light); font-weight: normal;">#${detection.id}</span>
        </div>
        <span class="confidence-badge ${confidenceClass}">${confidence.toFixed(1)}%</span>
      </div>
      
      <div class="detection-info">
        <div class="info-item">
          <span class="info-label">Category</span>
          <span class="info-value">${detection.category}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Price</span>
          <span class="info-value">$${detection.price}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Color</span>
          <span class="info-value">${detection.color}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Size</span>
          <span class="info-value">${detection.size}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Shape</span>
          <span class="info-value">${detection.shape}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Texture</span>
          <span class="info-value">${detection.texture}</span>
        </div>
      </div>

      ${detection.characteristics ? `
      <div style="margin-top: 12px;">
        <span class="info-label">Characteristics</span>
        <div class="tags">
          ${detection.characteristics.map(c => `<span class="tag">${c}</span>`).join('')}
        </div>
      </div>
      ` : ''}

      ${detection.uniqueFeatures && detection.uniqueFeatures.length > 0 ? `
      <div style="margin-top: 12px;">
        <span class="info-label">Features</span>
        <div class="tags" style="color: var(--secondary-color); background-color: rgba(247, 147, 30, 0.15);">
          ${detection.uniqueFeatures.map(f => `<span class="tag" style="background-color: rgba(247, 147, 30, 0.15); color: var(--secondary-color);">${f}</span>`).join('')}
        </div>
      </div>
      ` : ''}

      ${detection.boundingBox ? `
      <div style="margin-top: 12px; padding: 10px; background: rgba(0,0,0,0.05); border-radius: 4px;">
        <span class="info-label">Location</span>
        <div style="font-size: 0.85em; margin-top: 4px;">
          X: ${(detection.boundingBox.x * 100).toFixed(1)}% | Y: ${(detection.boundingBox.y * 100).toFixed(1)}%
          <br>Size: ${(detection.boundingBox.width * 100).toFixed(1)}% × ${(detection.boundingBox.height * 100).toFixed(1)}%
        </div>
      </div>
      ` : ''}

      <div style="margin-top: 10px; font-size: 0.8em; color: var(--text-light);">
        ⏱️ Response time: ${responseTime}ms
      </div>
    `;

    if (idx === 0) {
      resultsEl.innerHTML = '';
    }
    resultsEl.appendChild(detectionCard);
  });
  
  // Update tracked products for smart scanning
  trackedProducts = detections.map(d => ({
    id: d.id,
    bbox: d.boundingBox,
    lastSeen: Date.now()
  }));
}

// Motion detection helper: simple frame differencing on luminance
// Stricter thresholds to only detect when real objects move in frame
function detectMotion(currentFrameData, width, height) {
  if (!previousFrame || previousFrame.length !== currentFrameData.length) {
    previousFrame = new Uint8ClampedArray(currentFrameData);
    motionStabilityCount = 0;
    return false;
  }

  const totalPixels = Math.floor(currentFrameData.length / 4);
  const samplePixels = Math.min(3000, totalPixels);
  const pixelStep = Math.max(1, Math.floor(totalPixels / samplePixels));
  let pixelDifferences = 0;

  for (let p = 0; p < totalPixels; p += pixelStep) {
    const i = p * 4;
    const lumNow = (0.299 * currentFrameData[i] + 0.587 * currentFrameData[i+1] + 0.114 * currentFrameData[i+2]);
    const lumPrev = (0.299 * previousFrame[i] + 0.587 * previousFrame[i+1] + 0.114 * previousFrame[i+2]);
    const diff = Math.abs(lumNow - lumPrev);
    if (diff > 30) pixelDifferences++; // Increased from 22 to 30 for stricter motion detection
  }

  previousFrame.set(currentFrameData);

  const threshold = Math.floor(samplePixels * 0.08); // Increased from 0.06 to 0.08
  const detectedNow = pixelDifferences > threshold;

  if (detectedNow) motionStabilityCount = Math.min(motionStabilityRequired, motionStabilityCount + 1);
  else motionStabilityCount = 0;

  return motionStabilityCount >= motionStabilityRequired;
}

// Compute simple signature of frame to detect if NEW product appeared
function computeFrameSignature(imageData, width, height) {
  // Sample grid of 8x8 blocks and compute average color per block
  const gridSize = 8;
  const blockW = Math.floor(width / gridSize);
  const blockH = Math.floor(height / gridSize);
  const sig = [];
  
  for (let by = 0; by < gridSize; by++) {
    for (let bx = 0; bx < gridSize; bx++) {
      let r = 0, g = 0, b = 0, count = 0;
      
      for (let y = by * blockH; y < (by + 1) * blockH && y < height; y++) {
        for (let x = bx * blockW; x < (bx + 1) * blockW && x < width; x++) {
          const i = (y * width + x) * 4;
          r += imageData[i];
          g += imageData[i + 1];
          b += imageData[i + 2];
          count++;
        }
      }
      
      if (count > 0) {
        sig.push(Math.floor(r / count));
        sig.push(Math.floor(g / count));
        sig.push(Math.floor(b / count));
      }
    }
  }
  
  return sig;
}

// Compare two signatures to see if frame content changed significantly
function signaturesMatch(sig1, sig2, threshold = 25) {
  if (!sig1 || !sig2 || sig1.length !== sig2.length) return false;
  
  let diff = 0;
  for (let i = 0; i < sig1.length; i++) {
    diff += Math.abs(sig1[i] - sig2[i]);
  }
  
  const avgDiff = diff / sig1.length;
  return avgDiff < threshold; // if average difference < threshold, consider same
}

// Catalog Functions
async function loadCatalog() {
  try {
    console.log('📚 Loading catalog...');
    btnLoadCatalog.disabled = true;
    btnLoadCatalog.textContent = 'Loading...';

    const response = await fetch('/api/catalog');
    const data = await response.json();

    if (!data.success) {
      throw new Error('Failed to load catalog');
    }

    console.log(`✅ Loaded ${data.products.length} products`);
    displayCatalog(data.products);
    btnLoadCatalog.textContent = 'Reload Catalog';
  } catch (err) {
    console.error('❌ Catalog load error:', err);
    alert('❌ Could not load catalog: ' + err.message);
    btnLoadCatalog.textContent = 'Load Catalog';
  } finally {
    btnLoadCatalog.disabled = false;
  }
}

function displayCatalog(products) {
  console.log('🎨 Displaying catalog with', products.length, 'products');
  catalogEl.innerHTML = '';

  products.forEach(product => {
    const item = document.createElement('div');
    item.className = 'catalog-item';
    item.innerHTML = `
      <div class="catalog-name">${product.name}</div>
      <div class="catalog-price">$${product.price}</div>
      <div class="catalog-category">${product.category}</div>
    `;
    item.title = `${product.name} - ${product.type}`;
    catalogEl.appendChild(item);
  });
}

// Statistics
function updateStats(data, responseTime) {
  if (data.success && data.detections && data.detections.length > 0) {
    const detection = data.detections[0];
    detectionHistory.push({
      confidence: detection.confidence,
      responseTime: responseTime
    });

    // Update stats display
    const statDetections = document.getElementById('statDetections');
    const statConfidence = document.getElementById('statConfidence');
    const statTime = document.getElementById('statTime');

    statDetections.textContent = detectionHistory.length;

    const avgConfidence = (
      detectionHistory.reduce((sum, d) => sum + d.confidence, 0) / detectionHistory.length * 100
    ).toFixed(1);
    statConfidence.textContent = `${avgConfidence}%`;

    const avgTime = (
      detectionHistory.reduce((sum, d) => sum + d.responseTime, 0) / detectionHistory.length
    ).toFixed(0);
    statTime.textContent = `${avgTime}ms`;
  }
}

// Initialize
console.log('🚀 Intel Edge Insights Demo initialized');
initOverlayCanvas(); // Try to initialize overlay canvas immediately
loadCatalog(); // Auto-load catalog on page load

// Check camera availability on load
(async function checkCameraSupport() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const cameraCard = document.querySelector('.camera-card');
    if (cameraCard) {
      cameraCard.innerHTML = `
        <div style="background: rgba(255, 107, 107, 0.1); border: 2px solid #ff6b6b; padding: 20px; border-radius: 8px;">
          <p style="font-size: 1.2em; font-weight: 600; color: #ff6b6b; margin-bottom: 12px;">⚠️ Camera Not Supported</p>
          <p style="color: #ff6b6b;">Your browser doesn't support camera access. Please use Chrome, Edge, or Firefox.</p>
          <p style="color: #ff6b6b; margin-top: 12px;">You can still upload images using the upload section below.</p>
        </div>
      `;
    }
    btnStart.disabled = true;
    return;
  }

  // Check if on secure context
  if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    console.warn('Camera requires HTTPS or localhost. Current protocol:', window.location.protocol);
    resultsEl.innerHTML = `
      <div style="background: #fff3cd; border: 2px solid #ffc107; padding: 16px; border-radius: 8px;">
        <p style="color: #856404; font-weight: 600;">⚠️ Camera requires HTTPS or localhost</p>
        <p style="color: #856404; margin-top: 8px;">Access via: <strong>http://localhost:3000</strong></p>
      </div>
    `;
  }

  // Check camera permissions
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    
    if (videoDevices.length === 0) {
      console.warn('No camera devices found');
      resultsEl.innerHTML = `
        <div style="background: #fff3cd; border: 2px solid #ffc107; padding: 16px; border-radius: 8px;">
          <p style="color: #856404; font-weight: 600;">📷 No Camera Detected</p>
          <p style="color: #856404; margin-top: 8px;">Please connect a camera or use the image upload option.</p>
        </div>
      `;
    } else {
      console.log(`✅ Found ${videoDevices.length} camera(s):`, videoDevices.map(d => d.label || 'Camera'));
    }
  } catch (err) {
    console.error('Error checking camera devices:', err);
  }
})();
