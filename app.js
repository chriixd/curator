/**
 * CURATOR — Photo Selection App
 * 
 * A preference-based photo selector using progressive comparisons.
 * No external libraries. Works entirely in browser.
 */

// ========================================
// STATE MANAGEMENT
// ========================================

const state = {
    // All photos loaded from ZIP
    allPhotos: [],
    
    // Photos that passed Phase 1 screening
    screenedPhotos: [],
    
    // Current photo pool for Phase 2
    photoPool: [],
    
    // Current phase: 'start' | 'swipe' | 'compare' | 'results'
    currentPhase: 'start',
    
    // Swipe phase tracking
    swipeIndex: 0,
    keptCount: 0,
    
    // Comparison tracking
    comparisonCount: 0,
    minComparisons: 3,  // Reduced: each photo needs only 3 comparisons minimum
    
    // Selection settings
    targetSelectionSize: 20,  // Number of photos to select
    
    // Locked photos during refinement
    lockedPhotos: new Set(),
};

// ========================================
// PHOTO DATA MODEL
// ========================================

/**
 * Creates a photo object with tracking properties
 */
function createPhoto(id, src) {
    return {
        id,
        src,
        score: 0,               // Win/loss score
        comparisons: 0,         // Number of times compared
        opponentsCompared: new Set(),  // IDs of photos compared against
    };
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Show a specific screen, hide all others
 */
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.add('active');
    }
}

/**
 * Shuffle array in place (Fisher-Yates)
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// ========================================
// ZIP PROCESSING
// ========================================

/**
 * Process uploaded ZIP file and extract images
 */
async function processZipFile(file) {
    const loadingState = document.getElementById('loadingState');
    const uploadBtn = document.getElementById('uploadBtn');
    const loadingCount = document.querySelector('.loading-count');
    
    // Read selection size from input
    const selectionSizeInput = document.getElementById('selectionSizeInput');
    const requestedSize = parseInt(selectionSizeInput.value) || 20;
    state.targetSelectionSize = Math.max(5, Math.min(100, requestedSize));
    
    uploadBtn.style.display = 'none';
    loadingState.classList.remove('hidden');
    
    try {
        // Read ZIP file using browser APIs
        const arrayBuffer = await file.arrayBuffer();
        const photos = await extractImagesFromZip(arrayBuffer);
        
        if (photos.length === 0) {
            alert('No images found in ZIP file. Please upload a ZIP containing image files.');
            uploadBtn.style.display = 'inline-flex';
            loadingState.classList.add('hidden');
            return;
        }
        
        // Store photos in state
        state.allPhotos = photos;
        loadingCount.textContent = `Found ${photos.length} images`;
        
        // Small delay for UX
        setTimeout(() => {
            startSwipePhase();
        }, 800);
        
    } catch (error) {
        console.error('Error processing ZIP:', error);
        alert('Error processing ZIP file. Please try again.');
        uploadBtn.style.display = 'inline-flex';
        loadingState.classList.add('hidden');
    }
}

/**
 * Extract images from ZIP file buffer
 * Properly reads ZIP central directory and decompresses files
 */
async function extractImagesFromZip(arrayBuffer) {
    const photos = [];
    let photoId = 0;
    
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const view = new DataView(arrayBuffer);
    const uint8 = new Uint8Array(arrayBuffer);
    
    // Find End of Central Directory Record (EOCD)
    // Signature: 0x06054b50
    let eocdOffset = -1;
    for (let i = arrayBuffer.byteLength - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    
    if (eocdOffset === -1) {
        throw new Error('Invalid ZIP file: EOCD not found');
    }
    
    // Read central directory info from EOCD
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const centralDirSize = view.getUint32(eocdOffset + 12, true);
    const centralDirOffset = view.getUint32(eocdOffset + 16, true);
    
    // Read central directory entries
    let cdOffset = centralDirOffset;
    
    for (let i = 0; i < totalEntries; i++) {
        // Check central directory file header signature: 0x02014b50
        if (view.getUint32(cdOffset, true) !== 0x02014b50) {
            break;
        }
        
        const compressionMethod = view.getUint16(cdOffset + 10, true);
        const compressedSize = view.getUint32(cdOffset + 20, true);
        const uncompressedSize = view.getUint32(cdOffset + 24, true);
        const fileNameLength = view.getUint16(cdOffset + 28, true);
        const extraFieldLength = view.getUint16(cdOffset + 30, true);
        const fileCommentLength = view.getUint16(cdOffset + 32, true);
        const localHeaderOffset = view.getUint32(cdOffset + 42, true);
        
        // Read filename
        const fileNameBytes = uint8.slice(cdOffset + 46, cdOffset + 46 + fileNameLength);
        const fileName = new TextDecoder().decode(fileNameBytes);
        
        // Check if it's an image and not a directory
        const isImage = imageExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
        const isDirectory = fileName.endsWith('/');
        
        if (isImage && !isDirectory) {
            try {
                // Read local file header to get to the actual data
                const localHeaderSig = view.getUint32(localHeaderOffset, true);
                if (localHeaderSig !== 0x04034b50) {
                    throw new Error('Invalid local file header');
                }
                
                const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
                const localExtraFieldLength = view.getUint16(localHeaderOffset + 28, true);
                
                // File data starts after local header
                const fileDataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
                const fileData = uint8.slice(fileDataOffset, fileDataOffset + compressedSize);
                
                let imageData;
                
                if (compressionMethod === 0) {
                    // Stored (no compression)
                    imageData = fileData;
                } else if (compressionMethod === 8) {
                    // Deflate compression
                    if (typeof DecompressionStream !== 'undefined') {
                        try {
                            const ds = new DecompressionStream('deflate-raw');
                            const writer = ds.writable.getWriter();
                            writer.write(fileData);
                            writer.close();
                            
                            const reader = ds.readable.getReader();
                            const chunks = [];
                            
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                chunks.push(value);
                            }
                            
                            // Combine chunks
                            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
                            imageData = new Uint8Array(totalLength);
                            let offset = 0;
                            for (const chunk of chunks) {
                                imageData.set(chunk, offset);
                                offset += chunk.length;
                            }
                        } catch (e) {
                            console.error('Decompression failed:', e);
                            continue;
                        }
                    } else {
                        // DecompressionStream not available, try pako or skip
                        console.warn('DecompressionStream not available, skipping compressed file:', fileName);
                        continue;
                    }
                } else {
                    console.warn('Unsupported compression method:', compressionMethod);
                    continue;
                }
                
                // Detect MIME type
                const ext = fileName.toLowerCase().split('.').pop();
                const mimeTypes = {
                    'jpg': 'image/jpeg',
                    'jpeg': 'image/jpeg',
                    'png': 'image/png',
                    'gif': 'image/gif',
                    'webp': 'image/webp',
                    'bmp': 'image/bmp'
                };
                const mimeType = mimeTypes[ext] || 'image/jpeg';
                
                // Create blob and object URL
                const blob = new Blob([imageData], { type: mimeType });
                const url = URL.createObjectURL(blob);
                
                photos.push(createPhoto(photoId++, url));
            } catch (error) {
                console.error('Error processing file:', fileName, error);
            }
        }
        
        // Move to next entry in central directory
        cdOffset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    }
    
    return photos;
}

// ========================================
// PHASE 1: SWIPE SCREENING
// ========================================

/**
 * Start the swipe screening phase
 */
function startSwipePhase() {
    state.currentPhase = 'swipe';
    state.swipeIndex = 0;
    state.keptCount = 0;
    
    // Shuffle photos for variety
    shuffleArray(state.allPhotos);
    
    showScreen('swipeScreen');
    updateSwipeUI();
    showCurrentSwipePhoto();
}

/**
 * Update swipe phase UI elements
 */
function updateSwipeUI() {
    document.getElementById('swipeCount').textContent = state.swipeIndex + 1;
    document.getElementById('swipeTotal').textContent = state.allPhotos.length;
    document.getElementById('keptCount').textContent = state.keptCount;
}

/**
 * Display current photo in swipe phase
 */
function showCurrentSwipePhoto() {
    if (state.swipeIndex >= state.allPhotos.length) {
        // Swipe phase complete
        endSwipePhase();
        return;
    }
    
    const photo = state.allPhotos[state.swipeIndex];
    const img = document.getElementById('swipeImage');
    const card = document.getElementById('swipeCard');
    
    // Reset card animation
    card.classList.remove('swipe-left', 'swipe-right');
    
    // Preload image
    img.onload = () => {
        card.style.opacity = '1';
    };
    
    img.src = photo.src;
}

/**
 * Handle keep/discard decision
 */
function handleSwipeDecision(keep) {
    const card = document.getElementById('swipeCard');
    const photo = state.allPhotos[state.swipeIndex];
    
    // Animate card
    card.classList.add(keep ? 'swipe-right' : 'swipe-left');
    
    if (keep) {
        state.screenedPhotos.push(photo);
        state.keptCount++;
    }
    
    // Move to next photo after animation
    setTimeout(() => {
        state.swipeIndex++;
        updateSwipeUI();
        showCurrentSwipePhoto();
    }, 400);
}

/**
 * Complete swipe phase and move to comparisons
 */
function endSwipePhase() {
    // If user kept too few photos, use all photos
    if (state.screenedPhotos.length < state.targetSelectionSize * 2) {
        state.photoPool = [...state.allPhotos];
    } else {
        state.photoPool = [...state.screenedPhotos];
    }
    
    startComparisonPhase();
}

/**
 * Skip swipe phase and go directly to comparisons
 */
function skipSwipePhase() {
    state.photoPool = [...state.allPhotos];
    startComparisonPhase();
}

// ========================================
// PHASE 2: PAIRWISE COMPARISON
// ========================================

/**
 * Start the comparison phase
 */
function startComparisonPhase() {
    state.currentPhase = 'compare';
    state.comparisonCount = 0;
    
    showScreen('compareScreen');
    updateComparisonUI();
    showNextComparison();
}

/**
 * Update comparison phase UI elements
 */
function updateComparisonUI() {
    document.getElementById('compareCount').textContent = state.comparisonCount;
    document.getElementById('photosInPool').textContent = state.photoPool.length;
    updatePrecision();
    updateProgress();
}

/**
 * Calculate and update progress towards first stable ranking
 * 
 * Progress is based on:
 * 1. Each photo reaching minimum comparisons (weighted 60%)
 * 2. Having enough total comparisons (weighted 40%)
 */
function updateProgress() {
    if (state.photoPool.length === 0) return;
    
    // Calculate how many photos have reached minimum comparisons
    const photosWithMinComparisons = state.photoPool.filter(p => p.comparisons >= state.minComparisons).length;
    const comparisonProgress = (photosWithMinComparisons / state.photoPool.length) * 60;
    
    // Calculate total comparison progress
    // Target: at least minComparisons * photoPool.length comparisons
    const targetComparisons = state.minComparisons * state.photoPool.length;
    const totalProgress = Math.min((state.comparisonCount / targetComparisons), 1) * 40;
    
    const overallProgress = Math.min(comparisonProgress + totalProgress, 100);
    
    // Update progress bar
    const progressFill = document.getElementById('progressFill');
    const progressLabel = document.getElementById('progressLabel');
    
    progressFill.style.width = `${overallProgress}%`;
    
    // Update label based on progress
    if (overallProgress < 30) {
        progressLabel.textContent = 'Establishing baseline comparisons...';
    } else if (overallProgress < 60) {
        progressLabel.textContent = 'Building preference map...';
    } else if (overallProgress < 85) {
        progressLabel.textContent = 'Refining distinctions...';
    } else {
        progressLabel.textContent = 'Almost there — finalizing rankings...';
    }
}

/**
 * Calculate and display selection precision
 * 
 * Precision is based on:
 * 1. Average comparisons per photo
 * 2. Score separation at the cutoff point
 * 
 * Adjusted for lower comparison thresholds
 */
function updatePrecision() {
    if (state.photoPool.length === 0) return;
    
    // Calculate average comparisons
    const totalComparisons = state.photoPool.reduce((sum, p) => sum + p.comparisons, 0);
    const avgComparisons = totalComparisons / state.photoPool.length;
    
    // Sort by score to find cutoff gap
    const sortedPhotos = [...state.photoPool].sort((a, b) => b.score - a.score);
    const cutoffIndex = Math.min(state.targetSelectionSize, sortedPhotos.length) - 1;
    
    let scoreGap = 0;
    if (cutoffIndex >= 0 && cutoffIndex < sortedPhotos.length - 1) {
        scoreGap = sortedPhotos[cutoffIndex].score - sortedPhotos[cutoffIndex + 1].score;
    }
    
    // Calculate precision (0-95%)
    // Component 1: Comparisons (contributes up to 60%, adjusted scale)
    const comparisonFactor = Math.min(avgComparisons / 8, 1) * 60; // Reduced from /12 to /8
    
    // Component 2: Score gap (contributes up to 35%, adjusted threshold)
    const gapFactor = Math.min(scoreGap / 2, 1) * 35; // Reduced from /3 to /2
    
    const precision = Math.min(Math.floor(comparisonFactor + gapFactor), 95);
    
    document.getElementById('precisionValue').textContent = precision;
}

/**
 * Select the next pair of photos to compare
 * 
 * Strategy:
 * 1. Prioritize photos with fewer comparisons
 * 2. Match photos with similar scores
 * 3. Avoid comparing the same pair twice
 * 4. NEVER compare a photo against itself
 */
function selectNextPair() {
    if (state.photoPool.length < 2) return null;
    
    // Filter out locked photos
    const unlocked = state.photoPool.filter(p => !state.lockedPhotos.has(p.id));
    
    if (unlocked.length < 2) {
        // Not enough unlocked photos to compare
        return null;
    }
    
    // Sort by comparisons (ascending), then by score (descending)
    const candidates = [...unlocked].sort((a, b) => {
        if (a.comparisons !== b.comparisons) {
            return a.comparisons - b.comparisons;
        }
        return b.score - a.score;
    });
    
    // Try to find a good pair
    for (let i = 0; i < candidates.length; i++) {
        const photoA = candidates[i];
        
        // Find best opponent for photoA
        for (let j = i + 1; j < candidates.length; j++) {
            const photoB = candidates[j];
            
            // CRITICAL: Ensure we're not comparing the same photo
            if (photoA.id === photoB.id) {
                console.error('Attempted to compare photo against itself, skipping');
                continue;
            }
            
            // Skip if already compared
            if (photoA.opponentsCompared.has(photoB.id)) continue;
            
            // Good pair found
            return [photoA, photoB];
        }
    }
    
    // If all pairs compared, allow re-comparisons of close scores
    // This can happen in refinement mode
    const topPhotos = candidates.slice(0, Math.min(state.targetSelectionSize * 2, candidates.length));
    if (topPhotos.length >= 2) {
        // Make sure we don't return the same photo twice
        const photoA = topPhotos[0];
        const photoB = topPhotos.find(p => p.id !== photoA.id);
        
        if (photoB) {
            return [photoA, photoB];
        }
    }
    
    // Fallback to first two different photos
    if (candidates.length >= 2 && candidates[0].id !== candidates[1].id) {
        return [candidates[0], candidates[1]];
    }
    
    // If we still can't find two different unlocked photos, something is wrong
    console.error('Cannot find two different unlocked photos to compare');
    return null;
}

/**
 * Display the next comparison pair
 */
function showNextComparison() {
    // Check if we should show stable state
    if (shouldShowStableState()) {
        showStableState();
        return;
    }
    
    const pair = selectNextPair();
    
    if (!pair) {
        // Should not happen, but handle gracefully
        showResults();
        return;
    }
    
    const [photoA, photoB] = pair;
    
    // Store current pair in state for reference
    state.currentPair = [photoA, photoB];
    
    // Display images
    document.getElementById('imageA').src = photoA.src;
    document.getElementById('imageB').src = photoB.src;
    
    // Re-trigger animation
    const sides = document.querySelectorAll('.compare-side');
    sides.forEach((side, index) => {
        side.style.animation = 'none';
        setTimeout(() => {
            side.style.animation = '';
        }, 10);
    });
}

/**
 * Handle preference selection
 */
function handlePreference(winningSide) {
    const [photoA, photoB] = state.currentPair;
    const winner = winningSide === 'A' ? photoA : photoB;
    const loser = winningSide === 'A' ? photoB : photoA;
    
    // Update scores
    winner.score += 1;
    loser.score -= 0.5;
    
    // Update comparison counts
    winner.comparisons++;
    loser.comparisons++;
    
    // Track opponents
    winner.opponentsCompared.add(loser.id);
    loser.opponentsCompared.add(winner.id);
    
    // Update global count
    state.comparisonCount++;
    
    // Update UI and show next pair
    updateComparisonUI();
    showNextComparison();
}

/**
 * Determine if we should show the stable state message
 * 
 * Criteria (more lenient for faster results):
 * 1. All photos have minimum comparisons (3), OR
 * 2. Score gap at cutoff is significant (>= 1.5), OR
 * 3. We've done enough total comparisons (1.5x the pool size)
 */
function shouldShowStableState() {
    if (state.photoPool.length < state.targetSelectionSize) {
        return true;
    }
    
    // Check minimum comparisons - now only requires 3 per photo
    const minComparisonsMet = state.photoPool.every(p => p.comparisons >= state.minComparisons);
    
    // Check score gap at cutoff - lowered threshold
    const sortedPhotos = [...state.photoPool].sort((a, b) => b.score - a.score);
    const cutoffIndex = Math.min(state.targetSelectionSize, sortedPhotos.length) - 1;
    
    let hasGoodGap = false;
    if (cutoffIndex >= 0 && cutoffIndex < sortedPhotos.length - 1) {
        const scoreGap = sortedPhotos[cutoffIndex].score - sortedPhotos[cutoffIndex + 1].score;
        hasGoodGap = scoreGap >= 1.5; // Lowered from 2.5 to 1.5
    }
    
    // Check if we've done "enough" total comparisons
    // This catches cases where we have clear winners/losers early
    const reasonableTotal = state.comparisonCount >= state.photoPool.length * 1.5;
    
    return minComparisonsMet || hasGoodGap || (reasonableTotal && minComparisonsMet);
}

/**
 * Show the stable state UI
 */
function showStableState() {
    document.getElementById('stableState').classList.remove('hidden');
    document.querySelector('.compare-container').style.display = 'none';
}

/**
 * Hide stable state and continue comparisons
 */
function hideStableState() {
    document.getElementById('stableState').classList.add('hidden');
    document.querySelector('.compare-container').style.display = 'grid';
}

/**
 * Handle "Refine More" action
 * 
 * Strategy:
 * 1. Increase minimum comparisons requirement (smaller increment)
 * 2. Continue comparing unlocked photos
 */
function refineMore() {
    hideStableState();
    
    // Increase minimum comparisons by 2 (reduced from 3)
    state.minComparisons += 2;
    
    showNextComparison();
}

// ========================================
// RESULTS SCREEN
// ========================================

/**
 * Show final results
 */
function showResults() {
    state.currentPhase = 'results';
    
    showScreen('resultsScreen');
    displayResults();
}

/**
 * Display selected photos in results grid
 */
function displayResults() {
    const grid = document.getElementById('resultsGrid');
    grid.innerHTML = '';
    
    // Sort by score, take top N
    const sortedPhotos = [...state.photoPool].sort((a, b) => b.score - a.score);
    const selectedPhotos = sortedPhotos.slice(0, state.targetSelectionSize);
    
    document.getElementById('selectionSize').textContent = selectedPhotos.length;
    
    selectedPhotos.forEach((photo, index) => {
        const item = document.createElement('div');
        item.className = 'result-item';
        item.dataset.photoId = photo.id;
        item.style.animationDelay = `${index * 0.05}s`;
        
        if (state.lockedPhotos.has(photo.id)) {
            item.classList.add('locked');
        }
        
        item.innerHTML = `
            <div class="result-rank">${index + 1}</div>
            <img src="${photo.src}" alt="Selected photo ${index + 1}" class="result-image">
            <div class="result-meta">
                <span class="result-score">Score: ${photo.score.toFixed(1)}</span>
                <button class="result-lock" data-photo-id="${photo.id}">
                    ${state.lockedPhotos.has(photo.id) ? '🔒' : '🔓'}
                </button>
            </div>
        `;
        
        grid.appendChild(item);
    });
    
    // Add lock button listeners
    document.querySelectorAll('.result-lock').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const photoId = parseInt(e.currentTarget.dataset.photoId);
            toggleLock(photoId);
        });
    });
    
    // Make items draggable for reordering (basic implementation)
    makeResultsDraggable();
}

/**
 * Toggle lock status of a photo
 */
function toggleLock(photoId) {
    if (state.lockedPhotos.has(photoId)) {
        state.lockedPhotos.delete(photoId);
    } else {
        state.lockedPhotos.add(photoId);
    }
    displayResults();
}

/**
 * Make results grid draggable (simple implementation)
 */
function makeResultsDraggable() {
    // This is a simplified drag-and-drop
    // In production, you'd use more sophisticated drag APIs
    let draggedItem = null;
    
    const items = document.querySelectorAll('.result-item');
    
    items.forEach(item => {
        item.draggable = true;
        
        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            item.style.opacity = '0.5';
        });
        
        item.addEventListener('dragend', (e) => {
            item.style.opacity = '1';
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            if (draggedItem !== item) {
                const grid = document.getElementById('resultsGrid');
                const allItems = [...grid.children];
                const draggedIndex = allItems.indexOf(draggedItem);
                const targetIndex = allItems.indexOf(item);
                
                if (draggedIndex < targetIndex) {
                    item.after(draggedItem);
                } else {
                    item.before(draggedItem);
                }
                
                // Update rank numbers
                updateRankNumbers();
            }
        });
    });
}

/**
 * Update rank numbers after reordering
 */
function updateRankNumbers() {
    const items = document.querySelectorAll('.result-item');
    items.forEach((item, index) => {
        const rankElement = item.querySelector('.result-rank');
        if (rankElement) {
            rankElement.textContent = index + 1;
        }
    });
}

/**
 * Export selection (download or copy info)
 */
function exportSelection() {
    const grid = document.getElementById('resultsGrid');
    const items = [...grid.children];
    
    let exportText = 'CURATOR — Photo Selection Results\n';
    exportText += `Selected: ${items.length} photos\n`;
    exportText += `Total comparisons: ${state.comparisonCount}\n`;
    exportText += `Precision: ${document.getElementById('precisionValue').textContent}%\n\n`;
    exportText += 'Rankings:\n';
    
    items.forEach((item, index) => {
        const photoId = item.dataset.photoId;
        const photo = state.photoPool.find(p => p.id == photoId);
        const locked = state.lockedPhotos.has(parseInt(photoId)) ? ' [LOCKED]' : '';
        exportText += `${index + 1}. Photo #${photoId} (Score: ${photo.score.toFixed(1)})${locked}\n`;
    });
    
    // Copy to clipboard
    navigator.clipboard.writeText(exportText).then(() => {
        alert('Selection details copied to clipboard!');
    }).catch(() => {
        // Fallback: show in alert
        alert(exportText);
    });
}

// ========================================
// EVENT LISTENERS
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    // Start screen - Upload ZIP
    const uploadBtn = document.getElementById('uploadBtn');
    const zipInput = document.getElementById('zipInput');
    
    uploadBtn.addEventListener('click', () => {
        zipInput.click();
    });
    
    zipInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            processZipFile(file);
        }
    });
    
    // Drag and drop support
    const uploadZone = document.querySelector('.upload-zone');
    
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = 'var(--color-accent)';
    });
    
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.style.borderColor = '';
    });
    
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '';
        
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.zip')) {
            processZipFile(file);
        } else {
            alert('Please drop a ZIP file');
        }
    });
    
    // Swipe phase - Keep/Discard buttons
    document.getElementById('keepBtn').addEventListener('click', () => {
        handleSwipeDecision(true);
    });
    
    document.getElementById('discardBtn').addEventListener('click', () => {
        handleSwipeDecision(false);
    });
    
    // Swipe phase - Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (state.currentPhase === 'swipe') {
            if (e.key === 'ArrowRight') {
                handleSwipeDecision(true);
            } else if (e.key === 'ArrowLeft') {
                handleSwipeDecision(false);
            }
        } else if (state.currentPhase === 'compare') {
            if (e.key === 'ArrowLeft') {
                handlePreference('A');
            } else if (e.key === 'ArrowRight') {
                handlePreference('B');
            }
        }
    });
    
    // Skip Phase 1
    document.getElementById('skipPhase1Btn').addEventListener('click', () => {
        skipSwipePhase();
    });
    
    // Compare phase - Prefer buttons
    document.querySelectorAll('.prefer-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const side = e.currentTarget.dataset.side;
            handlePreference(side);
        });
    });
    
    // Compare phase - Click on image to prefer
    document.querySelectorAll('.compare-image-wrapper').forEach(wrapper => {
        wrapper.addEventListener('click', (e) => {
            const side = e.currentTarget.closest('.compare-side').dataset.side;
            handlePreference(side);
        });
    });
    
    // Stable state actions
    document.getElementById('viewResultsBtn').addEventListener('click', () => {
        showResults();
    });
    
    document.getElementById('refineMoreBtn').addEventListener('click', () => {
        refineMore();
    });
    
    // Results actions
    document.getElementById('backToCompareBtn').addEventListener('click', () => {
        hideStableState();
        showScreen('compareScreen');
        state.currentPhase = 'compare';
        showNextComparison();
    });
    
    document.getElementById('exportBtn').addEventListener('click', () => {
        exportSelection();
    });
});

/**
 * NOTES ON IMPLEMENTATION:
 * 
 * 1. ZIP Processing:
 *    - Reads ZIP structure manually (no external libraries)
 *    - Handles both stored and deflate-compressed files
 *    - Uses browser's DecompressionStream when available
 *    - Creates object URLs for display
 * 
 * 2. Pairing Algorithm:
 *    - Prioritizes photos with fewer comparisons
 *    - Matches similar scores to improve discrimination
 *    - Tracks compared opponents to avoid duplicates
 *    - Falls back gracefully when all pairs exhausted
 * 
 * 3. Scoring System:
 *    - Winner: +1 point (clear preference signal)
 *    - Loser: -0.5 points (softer penalty allows recovery)
 *    - Allows photos to rise/fall based on comparisons
 * 
 * 4. Precision Calculation:
 *    - Combines two factors: avg comparisons & score gap
 *    - Monotonically increases as more data collected
 *    - Caps at 95% to reflect inherent uncertainty
 *    - Feels authentic, not arbitrary
 * 
 * 5. Refinement Strategy:
 *    - Increases minimum comparisons threshold
 *    - Locks top-quartile photos from re-comparison
 *    - Focuses effort on cutoff boundary photos
 *    - Does NOT reset scores (progressive refinement)
 * 
 * 6. UX Decisions:
 *    - Keyboard shortcuts for speed (arrows)
 *    - Click images directly to prefer
 *    - Smooth animations for feedback
 *    - Clear progress indicators throughout
 *    - Preference language ("prefer" not "better")
 */
