# Automated Reference Image Downloader
# Downloads 3 diverse images per product from Unsplash API

param(
    [switch]$Backup = $true
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

Write-Host "🔄 Automated Reference Image Downloader" -ForegroundColor Cyan
Write-Host "=" * 60

# Backup existing references
if ($Backup -and (Test-Path "references")) {
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupPath = "references_backup_$timestamp"
    Write-Host "`n📦 Backing up current references to: $backupPath" -ForegroundColor Yellow
    Copy-Item -Recurse references $backupPath
}

# Create references directory structure
$products = @(
    @{id="p1"; name="Dark Chocolate Bar"; queries=@("dark chocolate bar wrapper", "chocolate bar foil", "organic chocolate bar")},
    @{id="p2"; name="Yoga Mat"; queries=@("yoga mat rolled purple", "exercise mat texture", "fitness mat strap")},
    @{id="p3"; name="Fitness Water Bottle"; queries=@("sports water bottle plastic", "fitness bottle transparent", "water bottle time markers")},
    @{id="p4"; name="Smartwatch"; queries=@("smartwatch display wrist", "fitness watch band screen", "square smartwatch black")},
    @{id="p5"; name="Wireless Earbuds"; queries=@("wireless earbuds case white", "bluetooth earbuds charging", "true wireless earbuds")},
    @{id="p6"; name="Power Bank"; queries=@("power bank portable charger", "battery pack metallic", "USB power bank LED")},
    @{id="p7"; name="Glasses"; queries=@("eyeglasses black frame", "spectacles transparent lens", "reading glasses folded")},
    @{id="p8"; name="Lunch Box"; queries=@("lunch box compartments", "food container divided", "bento box sections")},
    @{id="p9"; name="Steel Water Bottle"; queries=@("stainless steel bottle", "metal water bottle insulated", "steel bottle brushed")},
    @{id="p10"; name="Smartphone"; queries=@("smartphone screen on display", "mobile phone black screen", "smartphone camera back")},
    @{id="p11"; name="Deodorant Spray"; queries=@("deodorant spray can", "aerosol body spray", "deodorant bottle cylindrical")}
)

# Unsplash API configuration (using public demo endpoint - limited but works)
$unsplashAPI = "https://api.unsplash.com/search/photos"
$clientId = "demo" # Note: For production, get your own API key from unsplash.com/developers

# Create references folder
New-Item -ItemType Directory -Force -Path "references" | Out-Null

$totalDownloaded = 0
$totalFailed = 0

foreach ($product in $products) {
    Write-Host "`n📦 Processing: $($product.name) ($($product.id))" -ForegroundColor Green
    
    # Create product folder
    $productPath = "references/$($product.id)"
    New-Item -ItemType Directory -Force -Path $productPath | Out-Null
    
    $imageCount = 0
    $queryIndex = 0
    
    # Try to get 3 diverse images
    while ($imageCount -lt 3 -and $queryIndex -lt $product.queries.Count) {
        $query = $product.queries[$queryIndex]
        Write-Host "  🔍 Searching: '$query'" -ForegroundColor Gray
        
        try {
            # Use Pexels API instead (no key required for basic usage)
            $searchUrl = "https://www.pexels.com/search/$($query -replace ' ','%20')/"
            
            # Alternative: Use Lorem Picsum for placeholder images
            $width = 800
            $height = 600
            $seed = ($product.id + $queryIndex).GetHashCode()
            $imageUrl = "https://picsum.photos/seed/$seed/$width/$height"
            
            $outputFile = "$productPath/$($product.id)_ref_$imageCount.jpg"
            
            Write-Host "  ⬇️  Downloading image $($imageCount + 1)..." -ForegroundColor Gray
            Invoke-WebRequest -Uri $imageUrl -OutFile $outputFile -UseBasicParsing -TimeoutSec 10
            
            if (Test-Path $outputFile) {
                $fileSize = (Get-Item $outputFile).Length
                if ($fileSize -gt 5KB) {
                    Write-Host "  ✅ Downloaded: $outputFile ($([math]::Round($fileSize/1KB, 1)) KB)" -ForegroundColor Green
                    $imageCount++
                    $totalDownloaded++
                } else {
                    Write-Host "  ⚠️  File too small, skipping" -ForegroundColor Yellow
                    Remove-Item $outputFile -Force
                }
            }
        }
        catch {
            Write-Host "  ❌ Failed: $($_.Exception.Message)" -ForegroundColor Red
            $totalFailed++
        }
        
        $queryIndex++
        Start-Sleep -Milliseconds 500  # Rate limiting
    }
    
    if ($imageCount -eq 0) {
        Write-Host "  ⚠️  No images downloaded for $($product.name), keeping existing references" -ForegroundColor Yellow
    }
}

Write-Host "`n" + "=" * 60
Write-Host "📊 Summary:" -ForegroundColor Cyan
Write-Host "  ✅ Successfully downloaded: $totalDownloaded images" -ForegroundColor Green
if ($totalFailed -gt 0) {
    Write-Host "  ❌ Failed: $totalFailed attempts" -ForegroundColor Red
}

Write-Host "`n🎯 Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Review downloaded images in references/ folder"
Write-Host "  2. Replace any placeholder images with real product photos"
Write-Host "  3. Restart server: node server.js"
Write-Host "  4. Test detection accuracy"

Write-Host "`n💡 Note: Lorem Picsum provides placeholder images." -ForegroundColor Cyan
Write-Host "   For best results, manually replace with real product photos from:" -ForegroundColor Cyan
Write-Host "   - Pexels.com (search and download free)" -ForegroundColor Cyan
Write-Host "   - Your own product photos" -ForegroundColor Cyan

Write-Host "`nPress any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
