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
const resultsEl = document.getElementById('results');
const catalogEl = document.getElementById('catalog');
const btnLoadCatalog = document.getElementById('btnLoadCatalog');
const autoScanEl = document.getElementById('autoScan');
const cameraStatusEl = document.getElementById('camera-status');
const imageUpload = document.getElementById('imageUpload');
const uploadZone = document.getElementById('uploadZone');
const uploadPreview = document.getElementById('uploadPreview');
const btnScanUpload = document.getElementById('btnScanUpload');
const btnClearUpload = document.getElementById('btnClearUpload');

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

// Zone-based gating
let productZones = [];
let lastPersonBox = null;
let personInZoneCount = 0; // Debounce counter
const personInZoneThreshold = 2; // Require 2 consecutive frames
let activeZone = null;
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

// Event Listeners - Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 DOM loaded, initializing event listeners...');
  
  // Camera event listeners
  if (btnStart) btnStart.addEventListener('click', startCamera);
  if (btnCapture) btnCapture.addEventListener('click', captureAndDetect);
  if (btnStop) btnStop.addEventListener('click', stopCamera);
  if (autoScanEl) autoScanEl.addEventListener('change', toggleAutoScan);
  if (btnLoadCatalog) btnLoadCatalog.addEventListener('click', loadCatalog);

  // Image upload event listeners
  if (imageUpload) {
    // Make file input accessible
    imageUpload.removeAttribute('capture');
    imageUpload.style.display = 'none';
    
    imageUpload.addEventListener('change', handleImageSelect);
    console.log('✅ Image input change listener attached');
  } else {
    console.error('❌ File input not found');
  }
  
  if (uploadZone) {
    // Add drag and drop handlers
    uploadZone.addEventListener('dragover', handleDragOver);
    uploadZone.addEventListener('dragleave', handleDragLeave);
    uploadZone.addEventListener('drop', handleDrop);
    console.log('✅ Upload zone drag handlers attached');
  }
  
  if (btnScanUpload) {
    btnScanUpload.addEventListener('click', scanUploadedImage);
    console.log('✅ Scan button listener attached');
  }
  if (btnClearUpload) {
    btnClearUpload.addEventListener('click', clearUploadedImage);
    console.log('✅ Clear button listener attached');
  }

  // Drag and drop for upload
  if (uploadZone) {
    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('drag-over');
    });

    uploadZone.addEventListener('dragleave', () => {
      uploadZone.classList.remove('drag-over');
    });

    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length > 0 && files[0].type.startsWith('image/')) {
        handleImageFile(files[0]);
      }
    });
  }

  console.log('✅ Event listeners initialized');
  initOverlayCanvas();
  loadCatalog();
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
  
  // Load zones on first auto-scan
  if (productZones.length === 0) {
    loadZones();
  }
  
  // GATED SCANNING: Only detect when person is in zone
  console.log('🔄 Auto-scan started - person-gated mode');
  
  scanInterval = setInterval(() => {
    if (!video.videoWidth || !video.videoHeight) return;

    const w = video.videoWidth;
    const h = video.videoHeight;

    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    
    // Draw zones overlay
    drawZones();

    // Check for person detection first
    checkPersonAndGate().then(shouldDetect => {
      if (shouldDetect) {
        // Show loading state
        cameraStatusEl.textContent = 'Person in zone - analyzing...';
        cameraStatusEl.classList.add('active');
        console.log('✅ Person in zone, running detection...');
        
        // Use MAXIMUM quality for best accuracy
        canvas.toBlob((blob) => {
          sendDetectionRequest(blob, 'autoscan.jpg');
        }, 'image/jpeg', 0.98); // 98% quality for precision
      } else {
        // Idle state - no person in zone
        cameraStatusEl.textContent = 'Idle - waiting for person in product zone';
        cameraStatusEl.classList.remove('active', 'error');
      }
    });
    
  }, 2000); // Check every 2 seconds
}

// Check if person is in zone before allowing detection
async function checkPersonAndGate() {
  try {
    // Simple person detection using canvas analysis
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Detect motion/presence (basic heuristic)
    const hasMotion = detectMotionInFrame(imageData);
    
    if (!hasMotion) {
      personInZoneCount = 0;
      activeZone = null;
      return false;
    }
    
    // Estimate person box (center of motion)
    const personBox = estimatePersonBox(canvas.width, canvas.height);
    
    // Check proximity to zones
    if (productZones.length === 0) {
      // No zones configured, allow detection
      return true;
    }
    
    const proximityResult = checkPersonProximityLocal(personBox);
    
    if (proximityResult.inZone) {
      personInZoneCount++;
      activeZone = proximityResult;
      
      // Require debounce threshold
      if (personInZoneCount >= personInZoneThreshold) {
        console.log(`👤 Person in ${proximityResult.zoneName}`);
        return true;
      }
    } else {
      personInZoneCount = 0;
      activeZone = null;
    }
    
    return false;
  } catch (err) {
    console.error('Person check error:', err);
    return false; // Fail closed - don't detect if check fails
  }
}

// Local proximity check (client-side)
function checkPersonProximityLocal(personBox) {
  if (!personBox || !productZones.length) return { inZone: false };
  
  const personCenterX = personBox.x + (personBox.width / 2);
  const personCenterY = personBox.y + (personBox.height / 2);
  
  for (const zone of productZones) {
    const overlapsX = personCenterX >= zone.x && personCenterX <= (zone.x + zone.width);
    const overlapsY = personCenterY >= zone.y && personCenterY <= (zone.y + zone.height);
    
    if (overlapsX && overlapsY) {
      return {
        inZone: true,
        productId: zone.productId,
        zoneName: zone.name
      };
    }
  }
  
  return { inZone: false };
}

// Estimate person bounding box (simple heuristic - center of frame)
function estimatePersonBox(width, height) {
  // Assume person is in center 60% of frame
  return {
    x: width * 0.2,
    y: height * 0.1,
    width: width * 0.6,
    height: height * 0.8
  };
}

// Detect motion in current frame
function detectMotionInFrame(imageData) {
  if (!previousFrame) {
    previousFrame = imageData.data.slice();
    return true; // Assume motion on first frame
  }
  
  const data = imageData.data;
  let diffCount = 0;
  const threshold = 30;
  const sampleRate = 100; // Check every 100th pixel for speed
  
  for (let i = 0; i < data.length; i += sampleRate * 4) {
    const diff = Math.abs(data[i] - previousFrame[i]);
    if (diff > threshold) diffCount++;
  }
  
  previousFrame = data.slice();
  
  // If more than 5% of sampled pixels changed significantly
  const motionThreshold = (data.length / (sampleRate * 4)) * 0.05;
  return diffCount > motionThreshold;
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
    
    // Update status based on detection result
    if (data.detections && data.detections.length > 0) {
      cameraStatusEl.textContent = `✓ ${data.detections[0].type} (${(data.detections[0].confidence*100).toFixed(0)}%)`;
      cameraStatusEl.classList.remove('error');
      cameraStatusEl.classList.add('active');
    } else {
      cameraStatusEl.textContent = 'Ready - No product detected';
      cameraStatusEl.classList.remove('error', 'active');
    }
    
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
  
  // Draw humans (blue boxes - person outline)
  if (data.humans && data.humans.length > 0) {
    targetCtx.strokeStyle = '#2196f3'; // Blue for person
    targetCtx.lineWidth = 3;
    targetCtx.font = 'bold 18px Arial';
    targetCtx.fillStyle = '#2196f3';
    
    data.humans.forEach((human, idx) => {
      const bbox = human.boundingBox;
      const x = bbox.x * w;
      const y = bbox.y * h;
      const width = bbox.width * w;
      const height = bbox.height * h;
      
      targetCtx.strokeRect(x, y, width, height);
      
      // Person label with background
      targetCtx.fillStyle = 'rgba(33, 150, 243, 0.7)';
      targetCtx.fillRect(x, y - 30, 120, 30);
      targetCtx.fillStyle = '#ffffff';
      targetCtx.fillText(`👤 Person`, x + 10, y - 8);
    });
  }
  
  // Draw products (lime green boxes - product only)
  if (data.detections && data.detections.length > 0) {
    targetCtx.lineWidth = 5;
    targetCtx.font = 'bold 20px Arial';
    
    data.detections.forEach((product, idx) => {
      const bbox = product.boundingBox;
      const x = bbox.x * w;
      const y = bbox.y * h;
      const width = bbox.width * w;
      const height = bbox.height * h;
      
      // Product box in bright green (separate from person)
      targetCtx.strokeStyle = '#00ff00';
      targetCtx.fillStyle = '#00ff00';
      targetCtx.strokeRect(x, y, width, height);
      
      // Product label
      const label = `${product.type}`;
      const confidence = `${(product.confidence * 100).toFixed(1)}%`;
      
      // Background for text
      targetCtx.fillStyle = 'rgba(0, 255, 0, 0.85)';
      targetCtx.fillRect(x, y - 55, Math.max(220, targetCtx.measureText(label).width + 20), 55);
      
      // Text
      targetCtx.fillStyle = '#000000';
      targetCtx.font = 'bold 22px Arial';
      targetCtx.fillText(label, x + 10, y - 28);
      targetCtx.font = 'bold 18px Arial';
      targetCtx.fillText(confidence, x + 10, y - 6);
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
  if (!catalogEl) {
    console.error('❌ Catalog element not found');
    return;
  }
  
  console.log('🎨 Displaying catalog with', products.length, 'products:');
  products.forEach(p => console.log(`  - ${p.id}: ${p.name} ($${p.price})` ));
  
  catalogEl.innerHTML = '';

  if (!products || products.length === 0) {
    catalogEl.innerHTML = '<p class="catalog-placeholder">No products in catalog</p>';
    return;
  }

  products.forEach(product => {
    const item = document.createElement('div');
    item.className = 'catalog-item';
    item.innerHTML = `
      <div class="catalog-name">${product.name}</div>
      <div class="catalog-price">₹${product.price.toLocaleString('en-IN')}</div>
      <div class="catalog-category">${product.category}</div>
    `;
    item.title = `${product.name} - ${product.type}`;
    catalogEl.appendChild(item);
  });
}

// Load product zones
async function loadZones() {
  try {
    const response = await fetch('/api/zones');
    const data = await response.json();
    
    if (data.success && data.zones) {
      productZones = data.zones;
      console.log(`✅ Loaded ${productZones.length} product zones`);
      drawZones(); // Draw zones on canvas
    }
  } catch (err) {
    console.error('Failed to load zones:', err);
  }
}

// Draw zone overlays on canvas
function drawZones() {
  if (!canvas || !productZones.length) return;
  
  const ctx = canvas.getContext('2d');
  const videoWidth = video.videoWidth || 640;
  const videoHeight = video.videoHeight || 480;
  
  // Scale zones to canvas size
  const scaleX = canvas.width / videoWidth;
  const scaleY = canvas.height / videoHeight;
  
  productZones.forEach(zone => {
    const x = zone.x * scaleX;
    const y = zone.y * scaleY;
    const w = zone.width * scaleX;
    const h = zone.height * scaleY;
    
    // Different color if zone is active
    const isActive = activeZone && activeZone.productId === zone.productId;
    ctx.strokeStyle = isActive ? '#00ff00' : '#888888';
    ctx.lineWidth = isActive ? 3 : 2;
    ctx.strokeRect(x, y, w, h);
    
    // Label
    ctx.fillStyle = isActive ? '#00ff00' : '#ffffff';
    ctx.font = '14px Arial';
    ctx.fillText(zone.name || zone.productId, x + 5, y + 20);
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

// Initialize - moved to DOMContentLoaded above

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

// Image Upload Functions
function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  uploadZone.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  uploadZone.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  uploadZone.classList.remove('drag-over');
  
  const files = e.dataTransfer.files;
  console.log('📂 File dropped:', files.length, 'files');
  
  if (files.length > 0) {
    const file = files[0];
    if (file.type.startsWith('image/')) {
      console.log('✅ Valid image dropped:', file.name, file.type);
      // Manually trigger file input change
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      imageUpload.files = dataTransfer.files;
      handleImageFile(file);
    } else {
      console.error('❌ Invalid file type dropped:', file.type);
      alert('Please drop an image file (JPG, PNG, etc.)');
    }
  }
}

function handleImageSelect(e) {
  console.log('📂 handleImageSelect called', e.target.files);
  const file = e.target.files[0];
  if (file && file.type.startsWith('image/')) {
    console.log('✅ Valid image file:', file.name, file.type, file.size, 'bytes');
    handleImageFile(file);
  } else {
    console.error('❌ Invalid file type:', file?.type);
  }
}

function handleImageFile(file) {
  if (!uploadPreview || !uploadZone || !btnScanUpload || !btnClearUpload) {
    console.error('❌ Upload elements not found');
    return;
  }
  
  console.log('📂 Loading image:', file.name);
  const reader = new FileReader();
  reader.onload = (e) => {
    uploadPreview.src = e.target.result;
    uploadPreview.style.display = 'block';
    const placeholder = uploadZone.querySelector('.upload-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    btnScanUpload.disabled = false;
    btnClearUpload.style.display = 'inline-flex';
    console.log('✅ Image loaded successfully:', file.name);
  };
  reader.onerror = (err) => {
    console.error('❌ Failed to read image:', err);
    alert('Failed to load image. Please try another file.');
  };
  reader.readAsDataURL(file);
}

async function scanUploadedImage() {
  if (!uploadPreview || !uploadPreview.src) {
    console.error('❌ No image to scan');
    alert('Please select an image first');
    return;
  }
  
  console.log('🔍 Starting image scan...');
  btnScanUpload.disabled = true;
  btnScanUpload.innerHTML = '<span class="btn-icon">⏳</span><span>Scanning...</span>';
  
  try {
    // Create a temporary canvas to convert image to base64
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    const img = new Image();
    
    img.crossOrigin = 'anonymous'; // Allow cross-origin if needed
    
    img.onerror = () => {
      console.error('❌ Failed to load image for scanning');
      throw new Error('Failed to load image for scanning');
    };
    
    img.onload = async () => {
      try {
        console.log('📐 Image loaded:', img.width, 'x', img.height);
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        tempCtx.drawImage(img, 0, 0);
        
        const imageData = tempCanvas.toDataURL('image/jpeg', 0.98);
        console.log('📤 Sending image to server... (size:', imageData.length, 'chars)');
        
        // Send to server for detection
        const response = await fetch('/detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            image: imageData,
            source: 'upload'
          })
        });
        
        console.log('📡 Server responded with status:', response.status);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ Server error response:', errorText);
          throw new Error(`Server error: ${response.status}`);
        }
        
        const result = await response.json();
        console.log('📥 Server response:', result);
        
        // Display results
        displayUploadResults(result);
        
        // Scroll to results
        if (resultsEl) {
          resultsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        
      } catch (innerErr) {
        console.error('❌ Inner scan error:', innerErr);
        throw innerErr;
      } finally {
        btnScanUpload.disabled = false;
        btnScanUpload.innerHTML = '<span class="btn-icon">🔍</span><span>Scan Uploaded Image</span>';
      }
    };
    
    img.src = uploadPreview.src;
    
  } catch (err) {
    console.error('❌ Upload scan error:', err);
    if (resultsEl) {
      resultsEl.innerHTML = `
        <div class="error-state">
          <div class="error-icon">❌</div>
          <p class="error-title">Scan Failed</p>
          <p class="error-subtitle">${err.message}</p>
        </div>
      `;
    }
    btnScanUpload.disabled = false;
    btnScanUpload.innerHTML = '<span class="btn-icon">🔍</span><span>Scan Uploaded Image</span>';
  }
}

function clearUploadedImage() {
  if (uploadPreview) {
    uploadPreview.src = '';
    uploadPreview.style.display = 'none';
  }
  if (uploadZone) {
    const placeholder = uploadZone.querySelector('.upload-placeholder');
    if (placeholder) placeholder.style.display = 'flex';
  }
  if (btnScanUpload) btnScanUpload.disabled = true;
  if (btnClearUpload) btnClearUpload.style.display = 'none';
  if (imageUpload) imageUpload.value = '';
  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p class="empty-title">No Detections Yet</p>
        <p class="empty-subtitle">Capture an image or enable auto-scan</p>
      </div>
    `;
  }
  console.log('🗑️ Upload cleared');
}

function displayUploadResults(result) {
  console.log('📊 displayUploadResults called with:', result);
  
  if (!resultsEl) {
    console.error('❌ Results element not found!');
    return;
  }
  
  if (result.status === 'no_product_detected') {
    console.log('ℹ️ No product detected in image');
    resultsEl.innerHTML = `
      <div class="no-match-state">
        <div class="no-match-icon">🔍</div>
        <p class="no-match-title">No Product Detected</p>
        <p class="no-match-subtitle">Could not identify a known product in this image</p>
        <div class="detection-tips">
          <p><strong>Tips:</strong></p>
          <ul>
            <li>Ensure good lighting</li>
            <li>Product should be clearly visible</li>
            <li>Avoid blurry images</li>
            <li>Try a different angle</li>
          </ul>
        </div>
      </div>
    `;
    return;
  }
  
  if (result.status === 'success' && result.product) {
    const conf = (result.confidence * 100).toFixed(1);
    console.log('✅ Displaying product:', result.product.name, `${conf}% confidence`);
    
    resultsEl.innerHTML = `
      <div class="detection-success">
        <div class="success-header">
          <span class="success-icon">✅</span>
          <span class="success-badge">Product Found</span>
        </div>
        <div class="product-details">
          <h3 class="product-name">${result.product.name}</h3>
          <div class="product-meta">
            <span class="product-category">${result.product.category}</span>
            <span class="product-price">₹${result.product.price.toLocaleString('en-IN')}</span>
          </div>
          <div class="confidence-bar">
            <div class="confidence-label">
              <span>Confidence</span>
              <span class="confidence-value">${conf}%</span>
            </div>
            <div class="confidence-track">
              <div class="confidence-fill" style="width: ${conf}%"></div>
            </div>
          </div>
          ${result.product.description ? `<p class="product-description">${result.product.description}</p>` : ''}
        </div>
      </div>
    `;
    
    // Update stats
    detectionHistory.push(result.confidence);
    updateStats();
    
    console.log('✅ Upload detection displayed successfully');
  } else {
    console.error('❌ Unexpected result format:', result);
    resultsEl.innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <p class="error-title">Unexpected Response</p>
        <p class="error-subtitle">Server returned an unexpected format</p>
      </div>
    `;
  }
}
