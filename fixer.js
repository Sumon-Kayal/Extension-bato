(() => {
  
  const MAX_ATTEMPTS = 10;
  const MAX_SERVER_NUM = 15;
  
  const FALLBACK_PREFIXES = ['n', 'x', 't', 's', 'w', 'm', 'c', 'u', 'k'];
  const FALLBACK_ROOTS = ['mbdny.org', 'mbrtz.org', 'bato.to', 'mbwbm.org', 'mbznp.org', 'mbqgu.org'];

  const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d{1,3})\.([a-z0-9\-]+)\.(org|net|to)(\/.*)$/i;

  // Cache successful servers for faster fallbacks
  const serverCache = new Map();

  // 1. Parse URL
  function parseSubdomain(src) {
    const m = src.match(SUBDOMAIN_RE);
    if (!m) return null;
    return {
      prefix: m[1].toLowerCase(),
      number: parseInt(m[2], 10),
      root: m[3].toLowerCase(),
      tld: m[4].toLowerCase(),
      path: m[5]
    };
  }

  // 2. Generate fixed URL by changing k to n
  function generateFixedUrl(parsed) {
    // If it's a k server, change to n
    if (parsed.prefix === 'k') {
      return `https://n${String(parsed.number).padStart(2, '0')}.${parsed.root}.${parsed.tld}${parsed.path}`;
    }
    return null;
  }

  // 3. Generate fallback candidates for background probing
  function generateFallbackCandidates(parsed) {
    const candidates = [];
    const add = (p, n, r, t) => {
      candidates.push(`https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`);
    };

    // Try other prefixes (excluding k and n since we already tried n)
    const otherPrefixes = FALLBACK_PREFIXES.filter(p => p !== 'k' && p !== parsed.prefix);
    otherPrefixes.forEach(letter => {
      add(letter, parsed.number, parsed.root, parsed.tld);
    });

    // Try other root domains
    FALLBACK_ROOTS.forEach(root => {
      const parts = root.split('.');
      if (parts.length === 2 && parts[0] !== parsed.root) {
        add(parsed.prefix, parsed.number, parts[0], parts[1]);
      }
    });

    // Try number increments (limited)
    const numAttempts = Math.min(3, MAX_SERVER_NUM);
    for (let i = 0; i <= numAttempts; i++) {
      if (i !== parsed.number) {
        add(parsed.prefix, i, parsed.root, parsed.tld);
      }
    }

    return [...new Set(candidates)].slice(0, MAX_ATTEMPTS);
  }

  // 4. Quick check if URL is from a known problematic k server
  function isProblematicKServer(src) {
    const parsed = parseSubdomain(src);
    return parsed && parsed.prefix === 'k';
  }

  // 5. Preemptively fix k servers to n servers
  function preemptivelyFixImage(img) {
    const originalSrc = img.src;
    const parsed = parseSubdomain(originalSrc);
    
    if (!parsed || parsed.prefix !== 'k') {
      return false;
    }
    
    const fixedUrl = generateFixedUrl(parsed);
    if (!fixedUrl) {
      return false;
    }
    
    // Apply the fix immediately
    img.referrerPolicy = "no-referrer";
    img.src = fixedUrl;
    
    if (img.srcset) {
      const newSrcset = img.srcset.replace(
        /https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/gi, 
        fixedUrl.match(/^https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/i)[0]
      );
      img.srcset = newSrcset;
    }
    
    img.dataset.batoPreemptiveFix = "true";
    
    return true;
  }

  // 6. Background probe for images that still fail
  async function backgroundProbeImage(img) {
    if (img.dataset.batoBackgroundProbing === "true") {
      return;
    }
    
    img.dataset.batoBackgroundProbing = "true";
    
    // Wait a bit to see if the preemptive fix worked
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if the image is still broken
    if (img.complete && img.naturalWidth > 10) {
      img.dataset.batoBackgroundProbing = "done";
      return;
    }
    
    const parsed = parseSubdomain(img.src);
    if (!parsed) {
      img.dataset.batoBackgroundProbing = "done";
      return;
    }
    
    const candidates = generateFallbackCandidates(parsed);
    
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      
      try {
        // Quick test with a timeout
        const worked = await quickProbe(url);
        if (worked) {
          // Cache successful server pattern
          const cacheKey = `${parsed.prefix}-${parsed.root}`;
          serverCache.set(cacheKey, true);
          
          // Apply the fix
          img.referrerPolicy = "no-referrer";
          img.src = url;
          
          if (img.srcset) {
            const newSrcset = img.srcset.replace(
              /https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/gi, 
              url.match(/^https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/i)[0]
            );
            img.srcset = newSrcset;
          }
          
          img.dataset.batoBackgroundProbing = "done";
          return;
        }
      } catch (e) {
        // Candidate failed, continue to next
      }
      
      // Small delay between attempts
      if (i < candidates.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    img.dataset.batoBackgroundProbing = "done";
  }

  // 7. Quick probe function (simpler, no verification)
  function quickProbe(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let timedOut = false;
      
      const timeout = setTimeout(() => {
        timedOut = true;
        img.src = "";
        reject('timeout');
      }, 3000);
      
      img.onload = () => {
        if (!timedOut) {
          clearTimeout(timeout);
          if (img.width > 1 && img.height > 1) {
            resolve(true);
          } else {
            reject('empty');
          }
        }
      };
      
      img.onerror = () => {
        if (!timedOut) {
          clearTimeout(timeout);
          reject('error');
        }
      };
      
      img.src = url;
    });
  }

  // 8. Process an image with the new strategy
  function processImage(img) {
    if (img.dataset.batoProcessed === "true") {
      return;
    }
    
    img.dataset.batoProcessed = "true";
    
    // Only process manga page images
    if (!img.classList.contains('page-img') && !img.closest('#viewer')) {
      return;
    }
    
    // Check if it's a k server
    if (isProblematicKServer(img.src)) {
      // Try preemptive fix
      const fixed = preemptivelyFixImage(img);
      
      if (fixed) {
        // Start background probe in case preemptive fix doesn't work
        setTimeout(() => backgroundProbeImage(img), 3000);
      }
    }
    
    // For non-k images or images that are already broken, check after a delay
    const checkDelay = isProblematicKServer(img.src) ? 8000 : 3000;
    
    setTimeout(() => {
      // Check if image is still broken
      if (img.complete && img.naturalWidth === 0) {
        // This is a non-k image that's broken, or preemptive fix didn't work
        if (!isProblematicKServer(img.src)) {
          // Start background probe
          backgroundProbeImage(img);
        }
      }
    }, checkDelay);
  }

  // 9. Process all images on page
  function processAllImages() {
    const images = document.querySelectorAll('img.page-img, #viewer img');
    
    images.forEach((img) => {
      // Add error listener
      img.addEventListener('error', () => {
        // Give it a moment, then check
        setTimeout(() => {
          if (img.complete && img.naturalWidth === 0) {
            // If not already processed, process it
            if (!img.dataset.batoProcessed) {
              processImage(img);
            } else if (!img.dataset.batoBackgroundProbing) {
              // Already processed but still broken, try background probe
              backgroundProbeImage(img);
            }
          }
        }, 1000);
      });
      
      // Process the image
      processImage(img);
    });
  }

  // 10. Watch for new images
  function watchForNewImages() {
    let mutationTimeout;
    
    const observer = new MutationObserver((mutations) => {
      clearTimeout(mutationTimeout);
      mutationTimeout = setTimeout(() => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.tagName === 'IMG') {
              if (node.classList.contains('page-img') || node.closest('#viewer')) {
                // Add error listener
                node.addEventListener('error', () => {
                  setTimeout(() => {
                    if (node.complete && node.naturalWidth === 0 && !node.dataset.batoBackgroundProbing) {
                      backgroundProbeImage(node);
                    }
                  }, 1000);
                });
                
                // Process the new image
                setTimeout(() => processImage(node), 1000);
              }
            }
            
            if (node.querySelectorAll) {
              const innerImages = node.querySelectorAll('img.page-img, #viewer img');
              innerImages.forEach(img => {
                if (!img.dataset.batoProcessed) {
                  img.addEventListener('error', () => {
                    setTimeout(() => {
                      if (img.complete && img.naturalWidth === 0 && !img.dataset.batoBackgroundProbing) {
                        backgroundProbeImage(img);
                      }
                    }, 1000);
                  });
                  
                  setTimeout(() => processImage(img), 1000);
                }
              });
            }
          });
        });
      }, 500);
    });
    
    observer.observe(document.body, { 
      childList: true, 
      subtree: true 
    });
  }

  // 11. Initialize
  function init() {
    // Process existing images
    processAllImages();
    
    // Watch for new images
    watchForNewImages();
  }

  // Start the extension
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(init, 2000);
    });
  } else {
    setTimeout(init, 1000);
  }

})();
