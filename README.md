# Intel Edge Insights - Product Recognition Demo

A comprehensive AI-powered product recognition demo built with Express.js and vanilla JavaScript. This project demonstrates real-time product detection using mock inference responses with a modern, responsive web UI.

## Features

- **📷 Camera Integration**: Real-time camera feed with capture capability
- **🔍 Product Detection**: Mock AI inference for product recognition
- **📤 Image Upload**: Support for JPG, PNG, and WebP formats
- **🎯 Auto-Scan**: Motion-triggered continuous product detection
- **📊 Statistics**: Track detections, confidence scores, and response times
- **📚 Product Catalog**: Browse 17 pre-configured products
- **🎨 Modern UI**: Responsive design with Intel branding

## Project Structure

```
edge-insights-demo/
├── server.js              # Express backend with mock inference
├── package.json           # Dependencies and scripts
├── public/
│   ├── index.html        # Main UI
│   ├── app.js            # Frontend logic
│   └── styles.css        # Styling
├── catalog/
│   └── products.json     # Product database (17 items)
└── uploads/              # Uploaded images storage
```

## Setup & Installation

### Prerequisites
- Node.js 14+ and npm

### Installation

1. Install dependencies:
```bash
cd edge-insights-demo
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser:
```
http://localhost:3000
```

## API Endpoints

### POST `/api/detect`
Send an image for product detection.

**Request:**
```
FormData: { image: File }
```

**Response:**
```json
{
  "success": true,
  "filename": "image.jpg",
  "timestamp": "2025-11-18T12:00:00.000Z",
  "detections": [
    {
      "id": "p1",
      "type": "Coffee Mug",
      "category": "Beverages",
      "confidence": 0.87,
      "price": 12.99,
      "characteristics": ["ceramic", "cylindrical"],
      "color": "white",
      "shape": "cylinder",
      "size": "medium",
      "texture": "smooth",
      "packaging": "box",
      "uniqueFeatures": ["dishwasher safe"],
      "location": "aisle-5",
      "boundingBox": { "x": 0.2, "y": 0.3, "width": 0.4, "height": 0.5 }
    }
  ]
}
```

### GET `/api/catalog`
Retrieve the product catalog.

**Response:**
```json
{
  "success": true,
  "total": 17,
  "products": [...]
}
```

### GET `/api/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "Edge Insights Demo"
}
```

## Product Database

The catalog includes 17 diverse products across multiple categories:

- **Electronics**: Smartwatch, Wireless Earbuds, USB-C Power Bank
- **Beverages**: Coffee Beans, Matcha Tea, Protein Shake
- **Kitchen**: Espresso Machine, Ceramic Mugs, Lunch Box, Tumbler
- **Food**: Chocolate Bar, Granola, Almond Butter, Honey
- **Sports**: Yoga Mat, Water Bottle
- **Accessories**: Blue Light Glasses

Each product includes:
- Name, ID, category, type, price
- Physical characteristics (shape, color, size, texture)
- Packaging information
- Unique features and aisle location
- Mock confidence scores for detection

## Features

### Camera Capture
- Access device camera
- Live video preview
- One-click capture and detection
- Auto-scan with motion detection

### Image Upload
- Drag-and-drop interface
- Click to browse files
- Support for common formats

### Detection Results
- Confidence percentage (color-coded)
- Product details (price, category, characteristics)
- Bounding box information
- Response time metrics

### Auto-Scan Mode
- Continuous frame analysis every 2 seconds
- Motion-triggered detection
- Automatic result updates
- Low power consumption during inactivity

### Statistics
- Total detections count
- Average confidence score
- Average response time
- Historical tracking

## Mock Inference

The demo uses realistic mock inference that:
- Randomly selects products from the catalog
- Assigns confidence scores (0.5 - 0.99)
- Includes natural variance for realism
- Simulates processing delay (~300ms)
- Returns complete product metadata

## Browser Requirements

- Modern browser with WebRTC support
- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Requires user permission for camera

## Performance

- **Camera Stream**: 1280x720 @ 30fps (optional higher quality)
- **Detection Speed**: ~300ms per image
- **Catalog Size**: 17 products
- **Response Format**: JSON

## Development

### Start Development Server
```bash
npm run dev
```

### Modify Products
Edit `catalog/products.json` to add/modify products.

### Customize UI
Modify `public/styles.css` for styling changes.
Update `public/index.html` for layout modifications.

### Adjust Detection Parameters
Edit `server.js`:
- `generateMockResponse()`: Control confidence scoring
- Upload storage: Modify `multer` configuration

## Future Enhancements

- Real TensorFlow.js inference
- Barcode scanning
- Real-time video analytics dashboard
- Product price comparison
- Inventory management integration
- Computer vision model deployment

## License

MIT License - Educational Use

## Notes

- This is a **demo project** using mock inference
- Bounding boxes are randomly generated for illustration
- Confidence scores vary for realism
- For production use, integrate real computer vision models
- Uploaded images are stored in `uploads/` directory

## Troubleshooting

**Camera not working?**
- Check browser permissions
- Ensure HTTPS (for production) or localhost (for development)
- Try a different browser

**Detection failing?**
- Check server console for errors
- Verify backend is running (`http://localhost:3000/api/health`)
- Try a different image format

**Catalog not loading?**
- Ensure `catalog/products.json` exists
- Check JSON syntax
- Verify file permissions

## Support

For issues or questions, check:
1. Browser console (F12) for client-side errors
2. Server console for backend errors
3. Network tab to verify API calls
4. Product catalog validity

---

**Intel Edge Insights Demo v1.0.0**
Built with Express.js | Vanilla JavaScript | Modern CSS
