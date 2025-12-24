(() => {
  
  // Configuration
  const PROBE_TIMEOUT = 3000;  // 3 seconds - if it doesn't load by then, it's likely down
  const MAX_ATTEMPTS = 15;     // Try up to 15 'n' servers
  const MAX_SERVER_NUM = 15;   // Iterate through server numbers 00-15
  const RETRY_DELAY = 1000; 
  
  // ROOTS to fallback to (subdomain.ROOT.tld)
  const FALLBACK_ROOTS = ['mbdny.org', 'mbrtz.org', 'bato.to', 'mbwbm.org', 'mbznp.org', 'mbqgu.org'];
  
  const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d{1,3})\.([a-z0-9\-]+)\.(org|net|to)(\/.*)$/i;
  
  const serverCache = new Map(); // Remembers working servers per root
  const failedCache = new Set(); // Remembers dead URLs
  const processingImages = new WeakSet();

  // 1. Parse URL structure
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

  // 2. Test if a URL works
  function probeUrl(url, timeout = PROBE_TIMEOUT) {
    return new Promise((resolve, reject) => {
      // Check simple cache first
      const cacheKey = url.split('/').slice(0, 3).join('/');
      if (failedCache.has(cacheKey)) {
        reject('cached-fail');
        return;
      }
      
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        img.src = "";
        failedCache.add(cacheKey);
        reject('timeout');
      }, timeout);

      img.onload = () => {
        if (!timedOut) {
          clearTimeout(t);
          // Simple validation: tiny images are usually error placeholders
          if (img.width > 1 || img.height > 1) {
            resolve(true);
          } else {
            failedCache.add(cacheKey);
            reject('empty');
          }
        }
      };
      
      img.onerror = () => {
        if (!timedOut) {
          clearTimeout(t);
          failedCache.add(cacheKey);
          reject('error');
        }
      };
      
      img.src = url;
    });
  }

  // 3. Generate candidate URLs (STRICTLY K AND N ONLY)
  function generateCandidates(parsed) {
    const candidates = [];
    const pathKey = parsed.path.split('/').slice(0, 3).join('/'); 
    
    const add = (p, n, r, t, priority = 1) => {
      // STRICT FILTER: If it is not 'k' or 'n', do not attempt it.
      if (p !== 'k' && p !== 'n') return;
      
      const url = `https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`;
      candidates.push({ url, priority });
    };

    // Priority 0: Check success cache
    const cacheKey = `${parsed.root}-${pathKey}`;
    if (serverCache.has(cacheKey)) {
      const cached = serverCache.get(cacheKey);
      add(cached.prefix, cached.number, cached.root, cached.tld, 0);
    }

    // Priority 1: Instant Prefix Swap (The most likely fix)
    if (parsed.prefix === 'k') {
      // If currently K, try N immediately
      add('n', parsed.number, parsed.root, parsed.tld, 1);
    } else {
      // If currently N, try K (just in case)
      add('k', parsed.number, parsed.root, parsed.tld, 1);
    }

    // Priority 2: Load Balancing on the 'n' server
    // (Since 'k' is down, we prioritize trying 'n' with different numbers)
    for (let i = 0; i <= MAX_SERVER_NUM; i++) {
      if (i !== parsed.number) {
        add('n', i, parsed.root, parsed.tld, 2);
      }
    }

    // Priority 3: Fallback roots
    // If the domain itself is blocked, try alternate mirrors with 'n'
    FALLBACK_ROOTS.forEach(root => {
      const parts = root.split('.');
      if (parts.length === 2 && parts[0] !== parsed.root) {
        add('n', parsed.number, parts[0], parts[1], 4);
      }
    });

    const sorted = candidates
      .sort((a, b) => a.priority - b.priority)
      .map(c => c.url);
    
    return [...new Set(sorted)].slice(0, MAX_ATTEMPTS);
  }

  // 4. Update srcset for responsiveness
  function rewriteSrcset(srcset, workingUrl) {
    if (!srcset) return null;
    const workingParsed = parseSubdomain(workingUrl);
    if (!workingParsed) return null;
    const newBase = `https://${workingParsed.prefix}${String(workingParsed.number).padStart(2, '0')}.${workingParsed.root}.${workingParsed.tld}`;
    return srcset.replace(/https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/gi, newBase);
  }
  
  async function fixImage(img, isRetry = false) {
    // Prevent duplicate processing
    if (processingImages.has(img)) return;
    if (img.dataset.batoFixing === "done" || (img.dataset.batoFixing === "true" && !isRetry)) return;
    
    processingImages.add(img);
    img.dataset.batoFixing = "true";

    const parsed = parseSubdomain(img.src);
    if (!parsed) {
      processingImages.delete(img);
      return;
    }

    const candidates = generateCandidates(parsed);
    let lastError = null;

    // Iterate through candidates
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      const serverPattern = url.split('/').slice(0, 3).join('/');
      
      // Skip if this server cluster is known to be dead
      if (failedCache.has(serverPattern)) continue;
      
      try {
        await probeUrl(url, PROBE_TIMEOUT);
        
        // Success: Cache this server config
        const successParsed = parseSubdomain(url);
        if (successParsed) {
          const pathKey = parsed.path.split('/').slice(0, 3).join('/');
          const cacheKey = `${parsed.root}-${pathKey}`;
          serverCache.set(cacheKey, {
            prefix: successParsed.prefix,
            number: successParsed.number,
            root: successParsed.root,
            tld: successParsed.tld
          });
        }
        
        // Apply changes
        img.referrerPolicy = "no-referrer";
        img.src = url;
        
        if (img.srcset) {
          const newSrcset = rewriteSrcset(img.srcset, url);
          if (newSrcset) img.srcset = newSrcset;
        }

        img.dataset.batoFixing = "done";
        img.dataset.batoFixed = "true";
        processingImages.delete(img);
        return;
        
      } catch (e) {
        lastError = e;
        // Optimization: If the first few 'n' servers fail due to timeout, 
        // network might be the issue, stop early.
        if (e === 'timeout' && i > 6) break;
      }
    }
    
    // Failure handling
    if (!isRetry && lastError === 'timeout') {
      img.dataset.batoFixing = "retry";
      processingImages.delete(img);
      
      setTimeout(() => {
        if (img.complete && img.naturalWidth === 0) {
          fixImage(img, true);
        }
      }, RETRY_DELAY);
    } else {
      img.dataset.batoFixing = "failed";
      processingImages.delete(img);
    }
  }

  // 6. Fast Fix: Swaps 'k' to 'n' without checking connectivity first
  function preemptiveFix(img) {
    const parsed = parseSubdomain(img.src);
    if (!parsed) return false;
    
    // Logic: If 'k', switch to 'n'. Ignore everything else.
    if (parsed.prefix !== 'k') return false;
    
    const pathKey = parsed.path.split('/').slice(0, 3).join('/');
    const cacheKey = `${parsed.root}-${pathKey}`;
    
    let newPrefix = 'n'; 
    let newNumber = parsed.number;
    let newRoot = parsed.root;
    let newTld = parsed.tld;
    
    // Use cached working server if available
    if (serverCache.has(cacheKey)) {
      const cached = serverCache.get(cacheKey);
      newPrefix = cached.prefix;
      newNumber = cached.number;
      newRoot = cached.root;
      newTld = cached.tld;
    }
    
    // STRICT GUARD: Ensure we don't accidentally produce an 'x' or 't' url from old cache
    if (newPrefix !== 'k' && newPrefix !== 'n') newPrefix = 'n';

    const newUrl = `https://${newPrefix}${String(newNumber).padStart(2, '0')}.${newRoot}.${newTld}${parsed.path}`;
    
    // Save original to revert if this fix fails
    img.dataset.originalSrc = img.src;
    img.referrerPolicy = "no-referrer";
    img.src = newUrl;
    
    if (img.srcset) {
      img.dataset.originalSrcset = img.srcset;
      const newSrcset = rewriteSrcset(img.srcset, newUrl);
      if (newSrcset) img.srcset = newSrcset;
    }
    
    img.dataset.batoPreemptive = "true";
    return true;
  }

  // 7. Verify the preemptive fix
  function checkImage(img) {
    // If preemptive fix failed (still broken), try the full search (fixImage)
    if (img.dataset.batoPreemptive === "true" && img.complete && img.naturalWidth === 0) {
      if (img.dataset.originalSrc) {
        img.src = img.dataset.originalSrc; // Revert
        if (img.dataset.originalSrcset) img.srcset = img.dataset.originalSrcset;
      }
      img.dataset.batoPreemptive = "failed";
      fixImage(img);
      return;
    }
    
    // Standard check for broken images
    if (img.complete && img.naturalWidth === 0 && img.dataset.batoFixing !== "done") {
      fixImage(img);
    }
  }

  // 8. Handle new images added to DOM
  function processNewImage(img) {
    const parsed = parseSubdomain(img.src);
    
    // Instant modification if URL is 'k'
    if (parsed && parsed.prefix === 'k') {
      preemptiveFix(img);
      // Give it a moment to load, then verify
      setTimeout(() => checkImage(img), 2000);
    }
    
    // Listen for load errors
    img.addEventListener('error', function() {
      setTimeout(() => {
        if (img.dataset.batoFixing !== "done") {
          fixImage(img);
        }
      }, 100);
    }, { once: false });
  }

  // 9. Initialization and Observers
  function init() {
    // Scan existing
    document.querySelectorAll('img').forEach(img => {
      processNewImage(img);
      setTimeout(() => checkImage(img), 1000);
    });

    // Scan future (Infinity scroll/Chapters)
    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        // Handle added IMG nodes
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'IMG') {
            processNewImage(node);
            setTimeout(() => checkImage(node), 1000);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('img').forEach(img => {
              if (!img.dataset.batoFixing) {
                processNewImage(img);
                setTimeout(() => checkImage(img), 1000);
              }
            });
          }
        });
        
        // Handle attribute changes (src/srcset updates)
        if (mutation.type === 'attributes' && 
            (mutation.attributeName === 'src' || mutation.attributeName === 'srcset') && 
            mutation.target.tagName === 'IMG') {
          
          const img = mutation.target;
          // Only react if the change wasn't made by this script
          if (img.dataset.batoFixing !== "done" && !img.dataset.batoFixed) {
            img.dataset.batoFixing = "";
            img.dataset.batoPreemptive = "";
            setTimeout(() => {
              processNewImage(img);
              checkImage(img);
            }, 500);
          }
        }
      });
    });

    observer.observe(document.body, { 
      childList: true, 
      subtree: true, 
      attributes: true, 
      attributeFilter: ['src', 'srcset'] 
    });
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
