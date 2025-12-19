const fs = require('fs');
const FormData = require('form-data');
const http = require('http');

// Test images mapping
const testCases = [
  { product: 'p5', file: 'references/p5/p5_ref_0.jpg', expected: 'Smartphone' },
  { product: 'p6', file: 'references/p6/p6_ref_0.jpg', expected: 'Perfume Bottle' },
  { product: 'p1', file: 'references/p1/p1_ref_0.jpg', expected: 'Yoga Mat' },
  { product: 'p3', file: 'references/p3/p3_ref_0.jpg', expected: 'Wireless Earbuds' },
];

async function testDetection(testCase) {
  return new Promise((resolve, reject) => {
    console.log(`  → Testing ${testCase.file}...`);
    
    if (!fs.existsSync(testCase.file)) {
      reject({ testCase, error: `File not found: ${testCase.file}` });
      return;
    }

    const form = new FormData();
    form.append('image', fs.createReadStream(testCase.file));

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/detect',
      method: 'POST',
      headers: form.getHeaders(),
    };

    console.log(`  → Sending POST to ${options.hostname}:${options.port}${options.path}`);

    const req = http.request(options, (res) => {
      console.log(`  → Response status: ${res.statusCode}`);
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({ testCase, result });
        } catch (e) {
          reject({ testCase, error: `Parse error: ${e.message}`, raw: data });
        }
      });
    });

    req.on('error', (e) => {
      reject({ testCase, error: e.message });
    });

    form.on('error', (e) => {
      reject({ testCase, error: `Form error: ${e.message}` });
    });

    form.pipe(req);
  });
}

async function runTests() {
  console.log('Starting detection tests...\n');
  
  for (const testCase of testCases) {
    try {
      const { result } = await testDetection(testCase);
      
      // Extract product from detections array
      const detectedProduct = result.detections && result.detections.length > 0
        ? result.detections[0]
        : null;
      
      const passed = detectedProduct && detectedProduct.type === testCase.expected;
      const status = passed ? '✓ PASS' : '✗ FAIL';
      
      console.log(`${status} | ${testCase.product} → Expected: ${testCase.expected}`);
      console.log(`  Detected: ${detectedProduct ? detectedProduct.type : 'No product'}`);
      console.log(`  Confidence: ${detectedProduct && detectedProduct.confidence ? (detectedProduct.confidence * 100).toFixed(1) + '%' : 'N/A'}`);
      console.log(`  Message: ${result.message || 'N/A'}\n`);
    } catch (err) {
      console.log(`✗ ERROR | ${testCase.product}`);
      console.log(`  Error: ${JSON.stringify(err, null, 2)}\n`);
    }
  }
}

runTests().catch(console.error);
