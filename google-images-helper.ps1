# Google Images Download Helper
# Automates opening Google Images and downloading reference photos

param([int]$StartFrom = 1)

$products = @(
    @{id="p1"; num=1; name="Dark Chocolate Bar"; query="dark chocolate bar wrapped foil 85% cocoa"},
    @{id="p2"; num=2; name="Yoga Mat"; query="yoga mat rolled strap purple exercise"},
    @{id="p3"; num=3; name="Fitness Water Bottle"; query="sports water bottle plastic transparent time markers"},
    @{id="p4"; num=4; name="Smartwatch Fitness Tracker"; query="smartwatch fitness tracker display band wrist"},
    @{id="p5"; num=5; name="Wireless Earbuds"; query="wireless earbuds charging case white bluetooth"},
    @{id="p6"; num=6; name="USB-C Power Bank"; query="power bank portable charger 20000mah LED display USB-C"},
    @{id="p7"; num=7; name="Blue Light Glasses"; query="eyeglasses black frame transparent lens"},
    @{id="p8"; num=8; name="Portable Lunch Box"; query="lunch box compartments divided sections bento"},
    @{id="p9"; num=9; name="Stainless Steel Water Bottle"; query="stainless steel water bottle insulated brushed metal"},
    @{id="p10"; num=10; name="Smartphone"; query="smartphone black screen display triple camera"},
    @{id="p11"; num=11; name="Deodorant Spray"; query="deodorant spray can aerosol body spray cylindrical"}
)

# Filter products based on start point
$productsToProcess = $products | Where-Object { $_.num -ge $StartFrom }

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Google Images Download Helper" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "INSTRUCTIONS:" -ForegroundColor Yellow
Write-Host "1. Browser will open Google Images for each product" -ForegroundColor White
Write-Host "2. Find 3 good product images (different angles/lighting)" -ForegroundColor White
Write-Host "3. RIGHT-CLICK each image and select 'Save image as...'" -ForegroundColor White
Write-Host "4. Save to the Downloads folder with ANY name" -ForegroundColor White
Write-Host "5. Press ENTER in this window when done with all 3 images" -ForegroundColor White
Write-Host "6. Script will auto-rename and move them to correct location`n" -ForegroundColor White

Write-Host "TIP: Look for images that show:" -ForegroundColor Cyan
Write-Host "  - Different angles (front, side, 45 degrees)" -ForegroundColor Gray
Write-Host "  - Good lighting (bright, clear details)" -ForegroundColor Gray
Write-Host "  - Product features (screens, buttons, labels, etc.)" -ForegroundColor Gray
Write-Host "  - High resolution (larger images = better quality)`n" -ForegroundColor Gray

$downloadsFolder = "$env:USERPROFILE\Downloads"
$totalProcessed = 0

foreach ($product in $productsToProcess) {
    $totalProcessed++
    
    Write-Host "`n[$totalProcessed/$($productsToProcess.Count)] " -NoNewline -ForegroundColor Yellow
    Write-Host "Product: $($product.name) ($($product.id))" -ForegroundColor Green
    Write-Host ("=" * 60) -ForegroundColor Gray
    
    # Encode query for URL
    $encodedQuery = [System.Uri]::EscapeDataString($product.query)
    $googleImagesUrl = "https://www.google.com/search?tbm=isch&q=$encodedQuery"
    
    # Mark current time to identify newly downloaded files
    $timeBeforeDownload = Get-Date
    
    # Open Google Images
    Write-Host "`nOpening Google Images in browser..." -ForegroundColor Cyan
    Start-Process $googleImagesUrl
    
    Write-Host "`nWaiting for you to download 3 images..." -ForegroundColor Yellow
    Write-Host "Remember:" -ForegroundColor White
    Write-Host "  - Right-click images and 'Save image as...'" -ForegroundColor Gray
    Write-Host "  - Save to Downloads folder" -ForegroundColor Gray
    Write-Host "  - Choose 3 different views/angles" -ForegroundColor Gray
    Write-Host "`nPress ENTER when you've saved all 3 images for this product" -ForegroundColor Cyan
    
    Read-Host
    
    # Find recently downloaded images
    Write-Host "`nSearching for downloaded images..." -ForegroundColor Cyan
    Start-Sleep -Seconds 1
    
    $recentImages = Get-ChildItem -Path $downloadsFolder -File | 
        Where-Object { 
            $_.LastWriteTime -gt $timeBeforeDownload -and 
            ($_.Extension -match '\.(jpg|jpeg|png|webp)$')
        } | 
        Sort-Object LastWriteTime -Descending
    
    if ($recentImages.Count -eq 0) {
        Write-Host "ERROR: No images found in Downloads folder!" -ForegroundColor Red
        Write-Host "Please download 3 images and press ENTER to retry..." -ForegroundColor Yellow
        Read-Host
        
        # Retry search
        $recentImages = Get-ChildItem -Path $downloadsFolder -File | 
            Where-Object { 
                $_.LastWriteTime -gt $timeBeforeDownload -and 
                ($_.Extension -match '\.(jpg|jpeg|png|webp)$')
            } | 
            Sort-Object LastWriteTime -Descending
    }
    
    if ($recentImages.Count -lt 3) {
        Write-Host "WARNING: Only found $($recentImages.Count) image(s). Expected 3." -ForegroundColor Yellow
        Write-Host "Proceeding with available images..." -ForegroundColor Yellow
    }
    
    # Take first 3 images
    $imagesToUse = $recentImages | Select-Object -First 3
    
    # Create product folder
    $productPath = "references/$($product.id)"
    New-Item -ItemType Directory -Force -Path $productPath | Out-Null
    
    # Copy and rename images
    $imageIndex = 0
    foreach ($image in $imagesToUse) {
        $newName = "$($product.id)_ref_$imageIndex.jpg"
        $destinationPath = "$productPath/$newName"
        
        # Convert to JPG if needed and copy
        if ($image.Extension -eq '.jpg' -or $image.Extension -eq '.jpeg') {
            Copy-Item -Path $image.FullName -Destination $destinationPath -Force
        } else {
            # For PNG/WebP, just copy and rename (server can handle it)
            Copy-Item -Path $image.FullName -Destination $destinationPath -Force
        }
        
        $fileSize = [math]::Round((Get-Item $destinationPath).Length / 1024, 1)
        Write-Host "  Saved: $newName ($fileSize KB)" -ForegroundColor Green
        
        $imageIndex++
    }
    
    Write-Host "`nCompleted: $($product.name)" -ForegroundColor Green
    
    # Optional cleanup
    $cleanup = Read-Host "`nDelete downloaded images from Downloads folder? (y/n)"
    if ($cleanup -eq 'y') {
        foreach ($image in $imagesToUse) {
            Remove-Item -Path $image.FullName -Force
            Write-Host "  Deleted: $($image.Name)" -ForegroundColor Gray
        }
    }
    
    # Continue to next product
    if ($totalProcessed -lt $productsToProcess.Count) {
        Write-Host "`nReady for next product..." -ForegroundColor Cyan
        Start-Sleep -Seconds 2
    }
}

Write-Host "`n" + ("=" * 60) -ForegroundColor Cyan
Write-Host "ALL PRODUCTS COMPLETED!" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Cyan

# Verify all images
Write-Host "`nVerifying reference images..." -ForegroundColor Cyan
$verification = @()

foreach ($product in $products) {
    $productPath = "references/$($product.id)"
    if (Test-Path $productPath) {
        $imageCount = (Get-ChildItem -Path $productPath -File).Count
        $verification += @{
            Product = $product.name
            ID = $product.id
            Count = $imageCount
            Status = if ($imageCount -ge 3) { "OK" } else { "INCOMPLETE" }
        }
    } else {
        $verification += @{
            Product = $product.name
            ID = $product.id
            Count = 0
            Status = "MISSING"
        }
    }
}

$verification | ForEach-Object {
    $color = switch ($_.Status) {
        "OK" { "Green" }
        "INCOMPLETE" { "Yellow" }
        "MISSING" { "Red" }
    }
    Write-Host "$($_.ID): $($_.Product) - $($_.Count) images [$($_.Status)]" -ForegroundColor $color
}

Write-Host "`nNext Steps:" -ForegroundColor Yellow
Write-Host "1. Restart server to load new references" -ForegroundColor White
Write-Host "2. Test detection with camera" -ForegroundColor White
Write-Host "3. Check console for top-3 candidate scores`n" -ForegroundColor White
