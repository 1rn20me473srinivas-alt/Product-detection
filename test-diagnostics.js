const http = require('http');
const fs = require('fs');
const FormData = require('form-data');

async function testWithDiag(file, expected) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('image', fs.createReadStream(file));
    form.append('debug', 'true'); // Request debug info

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/detect',
      method: 'POST',
      headers: form.getHeaders(),
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log(`\n=== ${expected} ===`);
          console.log(JSON.stringify(result, null, 2));
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    form.pipe(req);
  });
}

(async () => {
  await testWithDiag('references/p6/p6_ref_0.jpg', 'Perfume Bottle');
  await testWithDiag('references/p1/p1_ref_0.jpg', 'Yoga Mat');
  await testWithDiag('references/p3/p3_ref_0.jpg', 'Wireless Earbuds');
})().catch(console.error);
