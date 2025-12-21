#!/usr/bin/env python3
"""
FAISS-based product similarity search service.
Extracts embeddings from images and provides fast nearest-neighbor search.
"""
import os
import json
import numpy as np
from pathlib import Path
from typing import List, Dict, Optional
from PIL import Image
import io
import logging

import faiss
import torch
import torchvision.transforms as transforms
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI
app = FastAPI(title="FAISS Product Search Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
faiss_index = None
product_mapping = []  # Maps index positions to product IDs
embedding_model = None
transform = None
device = None

# Configuration
EMBEDDING_DIM = 576  # MobileNetV3-Small output
CATALOG_PATH = "catalog/products.json"
REFERENCES_DIR = "references"


def load_embedding_model():
    """Load MobileNetV3 for feature extraction."""
    global embedding_model, transform, device
    
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    logger.info(f"Using device: {device}")
    
    # Load pretrained MobileNetV3-Small
    weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = mobilenet_v3_small(weights=weights)
    
    # Build embedding model: feature extractor + global avg pool to get 576-d vector
    # MobileNetV3-Small has 576 output channels before classifier.
    embedding_model = torch.nn.Sequential(
        model.features,
        torch.nn.AdaptiveAvgPool2d(1)
    )
    embedding_model = embedding_model.to(device)
    embedding_model.eval()
    
    # Image preprocessing
    transform = transforms.Compose([
        transforms.Resize(256),
        transforms.CenterCrop(224),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    
    logger.info("✅ Embedding model loaded (MobileNetV3-Small)")


def extract_embedding(image: Image.Image) -> np.ndarray:
    """Extract 576-dim embedding from an image."""
    if embedding_model is None:
        raise RuntimeError("Embedding model not initialized")
    
    # Convert to RGB if needed
    if image.mode != 'RGB':
        image = image.convert('RGB')
    
    # Preprocess and extract features
    img_tensor = transform(image).unsqueeze(0).to(device)
    
    with torch.no_grad():
        features = embedding_model(img_tensor)
        # Flatten and normalize to 576-dim
        embedding = features.view(features.size(0), -1).squeeze(0).cpu().numpy()
        # L2 normalize for cosine similarity via inner product
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
    
    return embedding


def build_faiss_index():
    """Build FAISS index from catalog references."""
    global faiss_index, product_mapping
    
    logger.info("📦 Building FAISS index from catalog references...")
    
    # Load catalog
    if not os.path.exists(CATALOG_PATH):
        logger.error(f"Catalog not found: {CATALOG_PATH}")
        return
    
    with open(CATALOG_PATH, 'r') as f:
        catalog = json.load(f)
    
    embeddings = []
    product_mapping = []
    
    for product in catalog:
        product_id = product.get('id', product['name'].replace(' ', '_').lower())
        ref_dir = os.path.join(REFERENCES_DIR, product_id)
        
        if not os.path.exists(ref_dir):
            logger.warning(f"  No references for {product_id}")
            continue
        
        # Process all reference images
        ref_files = [f for f in os.listdir(ref_dir) if f.endswith(('.jpg', '.jpeg', '.png'))]
        logger.info(f"  Processing {len(ref_files)} references for {product_id}...")
        
        for ref_file in ref_files:
            ref_path = os.path.join(ref_dir, ref_file)
            try:
                img = Image.open(ref_path)
                embedding = extract_embedding(img)
                embeddings.append(embedding)
                product_mapping.append({
                    'product_id': product_id,
                    'product_name': product['name'],
                    'ref_file': ref_file,
                    'price': product.get('price')
                })
            except Exception as e:
                logger.error(f"    Failed to process {ref_file}: {e}")
    
    if len(embeddings) == 0:
        logger.error("❌ No embeddings extracted!")
        return
    
    # Create FAISS index (using inner product for normalized vectors = cosine similarity)
    embeddings_matrix = np.array(embeddings).astype('float32')
    logger.info(f"  Embeddings shape: {embeddings_matrix.shape}")
    
    # Use IndexFlatIP (inner product) since vectors are normalized
    faiss_index = faiss.IndexFlatIP(EMBEDDING_DIM)
    faiss_index.add(embeddings_matrix)
    
    logger.info(f"✅ FAISS index built with {faiss_index.ntotal} vectors")
    logger.info(f"   Products: {set(p['product_id'] for p in product_mapping)}")


@app.on_event("startup")
async def startup_event():
    """Initialize on startup."""
    logger.info("🚀 Starting FAISS service...")
    load_embedding_model()
    build_faiss_index()


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": "FAISS Product Search",
        "index_size": faiss_index.ntotal if faiss_index else 0,
        "products": len(set(p['product_id'] for p in product_mapping)) if product_mapping else 0
    }


@app.post("/search")
async def search_product(
    image: UploadFile = File(...),
    k: int = 5
):
    """
    Search for similar products given an image.
    
    Args:
        image: Uploaded image file
        k: Number of top matches to return
    
    Returns:
        List of matches with product IDs, names, and similarity scores
    """
    if faiss_index is None:
        raise HTTPException(status_code=503, detail="FAISS index not initialized")
    
    try:
        # Read and process image
        image_bytes = await image.read()
        img = Image.open(io.BytesIO(image_bytes))
        
        # Extract embedding
        query_embedding = extract_embedding(img)
        query_embedding = query_embedding.reshape(1, -1).astype('float32')
        
        # Search FAISS index
        distances, indices = faiss_index.search(query_embedding, min(k, faiss_index.ntotal))
        
        # Format results
        results = []
        seen_products = set()
        
        for dist, idx in zip(distances[0], indices[0]):
            if idx < 0 or idx >= len(product_mapping):
                continue
            
            match_info = product_mapping[idx]
            product_id = match_info['product_id']
            
            # Aggregate by product (take best score per product)
            if product_id not in seen_products:
                results.append({
                    'product_id': product_id,
                    'product_name': match_info['product_name'],
                    'similarity': float(dist),  # Cosine similarity (0-1, higher is better)
                    'ref_file': match_info['ref_file'],
                    'price': match_info.get('price')
                })
                seen_products.add(product_id)
            
            if len(results) >= k:
                break
        
        logger.info(f"  Query returned {len(results)} matches")
        return {
            "success": True,
            "matches": results,
            "query_shape": query_embedding.shape
        }
        
    except Exception as e:
        logger.error(f"Search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/rebuild")
async def rebuild_index():
    """Rebuild the FAISS index from current references."""
    try:
        build_faiss_index()
        return {
            "success": True,
            "index_size": faiss_index.ntotal if faiss_index else 0
        }
    except Exception as e:
        logger.error(f"Rebuild error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    # Run the service
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8001,
        log_level="info"
    )