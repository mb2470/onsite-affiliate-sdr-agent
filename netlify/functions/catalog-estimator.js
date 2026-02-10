// Netlify serverless function to estimate product catalog size
// Crawls website to find product count and ecommerce platform

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { website } = JSON.parse(event.body);
    
    if (!website) {
      throw new Error('Website URL is required');
    }

    // Normalize URL
    const baseUrl = website.startsWith('http') ? website : `https://${website}`;
    const domain = new URL(baseUrl).hostname;

    console.log(`Analyzing catalog for: ${domain}`);

    // Results object
    const analysis = {
      website: domain,
      platform: 'Unknown',
      estimatedProducts: 0,
      categories: 0,
      productUrlPattern: null,
      confidence: 'low',
      details: []
    };

    // 1. Try to fetch sitemap
    const sitemapUrl = `${baseUrl}/sitemap.xml`;
    let productCount = 0;
    
    try {
      const sitemapResponse = await fetch(sitemapUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProductCrawler/1.0)' },
        timeout: 10000
      });

      if (sitemapResponse.ok) {
        const sitemapText = await sitemapResponse.text();
        
        // Count product URLs in sitemap
        const productPatterns = [
          /\/products?\//gi,
          /\/shop\//gi,
          /\/store\//gi,
          /\/item\//gi,
          /\/p\//gi,
          /\/collections?\/.*\/products/gi
        ];

        productPatterns.forEach(pattern => {
          const matches = sitemapText.match(pattern);
          if (matches) {
            productCount += matches.length;
          }
        });

        if (productCount > 0) {
          analysis.estimatedProducts = productCount;
          analysis.confidence = 'high';
          analysis.details.push(`Found ${productCount} product URLs in sitemap`);
        }

        // Detect URL pattern
        if (sitemapText.includes('/products/')) {
          analysis.productUrlPattern = '/products/{slug}';
        } else if (sitemapText.includes('/shop/')) {
          analysis.productUrlPattern = '/shop/{slug}';
        } else if (sitemapText.includes('/p/')) {
          analysis.productUrlPattern = '/p/{id}';
        }
      }
    } catch (error) {
      console.log('Sitemap not accessible:', error.message);
      analysis.details.push('Sitemap not accessible, using fallback methods');
    }

    // 2. Detect ecommerce platform from homepage
    try {
      const homepageResponse = await fetch(baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProductCrawler/1.0)' },
        timeout: 10000
      });

      if (homepageResponse.ok) {
        const html = await homepageResponse.text();
        
        // Platform detection
        if (html.includes('Shopify') || html.includes('cdn.shopify.com')) {
          analysis.platform = 'Shopify';
          analysis.details.push('Detected Shopify platform');
        } else if (html.includes('woocommerce')) {
          analysis.platform = 'WooCommerce';
          analysis.details.push('Detected WooCommerce platform');
        } else if (html.includes('Magento') || html.includes('magento')) {
          analysis.platform = 'Magento';
          analysis.details.push('Detected Magento platform');
        } else if (html.includes('BigCommerce')) {
          analysis.platform = 'BigCommerce';
          analysis.details.push('Detected BigCommerce platform');
        } else if (html.includes('Salesforce Commerce Cloud')) {
          analysis.platform = 'Salesforce Commerce Cloud';
          analysis.details.push('Detected Salesforce Commerce Cloud');
        }

        // If no sitemap data, estimate from pagination or collection pages
        if (productCount === 0) {
          // Try to find product count in JSON-LD or meta tags
          const jsonLdMatch = html.match(/"numberOfItems":\s*(\d+)/);
          if (jsonLdMatch) {
            analysis.estimatedProducts = parseInt(jsonLdMatch[1]);
            analysis.confidence = 'medium';
            analysis.details.push('Found product count in structured data');
          }

          // Look for collection/category counts
          const categoryMatches = html.match(/\/collections?\//gi);
          if (categoryMatches) {
            analysis.categories = Math.min(categoryMatches.length, 50); // Cap at 50
          }
        }
      }
    } catch (error) {
      console.log('Homepage not accessible:', error.message);
      analysis.details.push('Could not access homepage');
    }

    // 3. Try Shopify products.json endpoint (if Shopify detected)
    if (analysis.platform === 'Shopify' && productCount === 0) {
      try {
        const productsJsonUrl = `${baseUrl}/products.json?limit=250`;
        const productsResponse = await fetch(productsJsonUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProductCrawler/1.0)' },
          timeout: 10000
        });

        if (productsResponse.ok) {
          const productsData = await productsResponse.json();
          if (productsData.products && productsData.products.length > 0) {
            // Shopify limits to 250 per page, so if we get 250, there are likely more
            analysis.estimatedProducts = productsData.products.length === 250 
              ? 'More than 250' 
              : productsData.products.length;
            analysis.confidence = productsData.products.length === 250 ? 'medium' : 'high';
            analysis.details.push(`Found ${productsData.products.length} products via Shopify API`);
            analysis.productUrlPattern = '/products/{handle}';
          }
        }
      } catch (error) {
        console.log('Shopify API not accessible:', error.message);
      }
    }

    // 4. Fallback: Estimate based on platform
    if (analysis.estimatedProducts === 0) {
      analysis.confidence = 'low';
      if (analysis.platform !== 'Unknown') {
        analysis.estimatedProducts = 'Unknown (platform detected but catalog not accessible)';
        analysis.details.push('Unable to determine exact count - manual verification recommended');
      } else {
        analysis.estimatedProducts = 'Unknown (could not detect ecommerce platform)';
        analysis.details.push('This may not be an ecommerce site');
      }
    }

    // Add qualification score
    const productNum = typeof analysis.estimatedProducts === 'number' ? analysis.estimatedProducts : 0;
    if (productNum > 1000) {
      analysis.qualification = 'HIGH PRIORITY - Large catalog, excellent fit';
    } else if (productNum > 100) {
      analysis.qualification = 'GOOD FIT - Medium catalog size';
    } else if (productNum > 0) {
      analysis.qualification = 'POTENTIAL - Small catalog';
    } else {
      analysis.qualification = 'NEEDS VERIFICATION - Manual check recommended';
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analysis)
    };

  } catch (error) {
    console.error('Catalog estimation error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: error.message || 'Failed to estimate catalog size',
        details: error.toString()
      })
    };
  }
};
