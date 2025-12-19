const { addon: ov } = require('openvino-node');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

class OpenVINODetector {
  constructor(modelsPath) {
    this.modelsPath = modelsPath;
    this.core = null;
    this.model = null;
    this.compiledModel = null;
    this.inferRequest = null;
    this.initialized = false;
  }

  async initialize() {
    try {
      console.log('🔧 Initializing OpenVINO Core...');
      this.core = new ov.Core();

      // Try to load YOLOv5 model for object detection
      const modelPath = path.join(this.modelsPath, 'yolov5s-fp16.xml');
      
      if (!fs.existsSync(modelPath)) {
        throw new Error(`Model not found: ${modelPath}`);
      }

      console.log(`📦 Loading model: ${modelPath}`);
      this.model = await this.core.readModel(modelPath);

      // Get input/output info
      const inputInfo = this.model.input();
      console.log(`  Input shape: [${inputInfo.shape}]`);
      console.log(`  Input type: ${inputInfo.elementType}`);

      const outputInfo = this.model.output();
      console.log(`  Output shape: [${outputInfo.shape}]`);

      // Compile model for CPU
      console.log('⚙️  Compiling model for CPU device...');
      this.compiledModel = await this.core.compileModel(this.model, 'CPU');
      this.inferRequest = this.compiledModel.createInferRequest();

      this.initialized = true;
      console.log('✅ OpenVINO detector initialized successfully\n');
      return true;
    } catch (error) {
      console.error('❌ OpenVINO initialization failed:', error.message);
      this.initialized = false;
      return false;
    }
  }

  async detect(imagePath) {
    if (!this.initialized) {
      throw new Error('OpenVINO detector not initialized');
    }

    try {
      // Load and preprocess image
      const image = await Jimp.read(imagePath);
      const inputShape = this.model.input().shape;
      const [, , inputHeight, inputWidth] = inputShape;

      // Resize image to model input size
      const resized = image.clone().resize(inputWidth, inputHeight);
      
      // Convert to RGB and normalize to [0, 1]
      const imageData = new Float32Array(inputWidth * inputHeight * 3);
      let idx = 0;
      
      resized.scan(0, 0, inputWidth, inputHeight, (x, y, offset) => {
        const pixel = Jimp.intToRGBA(resized.getPixelColor(x, y));
        // NCHW format: [batch, channels, height, width]
        // Normalize to [0, 1]
        imageData[idx] = pixel.r / 255.0;
        imageData[idx + inputWidth * inputHeight] = pixel.g / 255.0;
        imageData[idx + 2 * inputWidth * inputHeight] = pixel.b / 255.0;
        idx++;
      });

      // Create input tensor
      const inputTensor = new ov.Tensor(ov.element.f32, inputShape, imageData);

      // Run inference
      const inferResult = await this.inferRequest.inferAsync([inputTensor]);
      const outputTensor = inferResult[this.model.output()];
      const outputData = outputTensor.data;

      // Parse YOLO output: [batch, num_detections, 85] where 85 = [x, y, w, h, conf, ...80 classes]
      const detections = this.parseYOLOOutput(
        outputData,
        outputTensor.shape,
        image.bitmap.width,
        image.bitmap.height,
        inputWidth,
        inputHeight
      );

      return detections;
    } catch (error) {
      console.error('❌ OpenVINO detection error:', error.message);
      throw error;
    }
  }

  parseYOLOOutput(data, shape, origWidth, origHeight, modelWidth, modelHeight) {
    const detections = [];
    const [, numDetections, attributesPerBox] = shape;
    const confidenceThreshold = 0.4;
    const nmsThreshold = 0.45;

    // YOLO output format: [x, y, w, h, objectness, class0_score, class1_score, ...]
    const boxes = [];
    
    for (let i = 0; i < numDetections; i++) {
      const offset = i * attributesPerBox;
      const objectness = data[offset + 4];
      
      if (objectness < confidenceThreshold) continue;

      // Get class scores (skip first 5: x, y, w, h, objectness)
      let maxClassScore = 0;
      let maxClassIndex = 0;
      
      for (let c = 0; c < attributesPerBox - 5; c++) {
        const classScore = data[offset + 5 + c];
        if (classScore > maxClassScore) {
          maxClassScore = classScore;
          maxClassIndex = c;
        }
      }

      const confidence = objectness * maxClassScore;
      
      if (confidence < confidenceThreshold) continue;

      // Convert from model coordinates to original image coordinates
      const x = data[offset] / modelWidth * origWidth;
      const y = data[offset + 1] / modelHeight * origHeight;
      const w = data[offset + 2] / modelWidth * origWidth;
      const h = data[offset + 3] / modelHeight * origHeight;

      boxes.push({
        x: x - w / 2,
        y: y - h / 2,
        width: w,
        height: h,
        confidence,
        classId: maxClassIndex,
        className: this.getClassName(maxClassIndex)
      });
    }

    // Apply Non-Maximum Suppression
    const finalBoxes = this.applyNMS(boxes, nmsThreshold);
    
    return finalBoxes;
  }

  applyNMS(boxes, threshold) {
    if (boxes.length === 0) return [];

    // Sort by confidence
    boxes.sort((a, b) => b.confidence - a.confidence);

    const selected = [];
    const suppressed = new Set();

    for (let i = 0; i < boxes.length; i++) {
      if (suppressed.has(i)) continue;
      
      selected.push(boxes[i]);
      
      for (let j = i + 1; j < boxes.length; j++) {
        if (suppressed.has(j)) continue;
        
        const iou = this.calculateIoU(boxes[i], boxes[j]);
        if (iou > threshold) {
          suppressed.add(j);
        }
      }
    }

    return selected;
  }

  calculateIoU(box1, box2) {
    const x1 = Math.max(box1.x, box2.x);
    const y1 = Math.max(box1.y, box2.y);
    const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
    const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area1 = box1.width * box1.height;
    const area2 = box2.width * box2.height;
    const union = area1 + area2 - intersection;

    return union > 0 ? intersection / union : 0;
  }

  getClassName(classId) {
    // COCO dataset class names
    const classes = [
      'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
      'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
      'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
      'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
      'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
      'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
      'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
      'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
      'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
      'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
    ];
    
    return classId < classes.length ? classes[classId] : `class_${classId}`;
  }

  cleanup() {
    if (this.inferRequest) {
      this.inferRequest = null;
    }
    if (this.compiledModel) {
      this.compiledModel = null;
    }
    if (this.model) {
      this.model = null;
    }
    if (this.core) {
      this.core = null;
    }
    this.initialized = false;
  }
}

module.exports = OpenVINODetector;
