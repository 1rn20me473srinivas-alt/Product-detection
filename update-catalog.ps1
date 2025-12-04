# Update catalog to use 3 references per product

$catalogPath = "catalog/products.json"
$catalog = Get-Content $catalogPath -Raw | ConvertFrom-Json

foreach ($product in $catalog) {
    $productId = $product.id
    $product.references = @(
        "references/$productId/${productId}_ref_0.jpg",
        "references/$productId/${productId}_ref_1.jpg",
        "references/$productId/${productId}_ref_2.jpg"
    )
}

$catalog | ConvertTo-Json -Depth 10 | Set-Content $catalogPath

Write-Host "✅ Updated catalog to use 3 reference images per product" -ForegroundColor Green
