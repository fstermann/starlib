"""
Example script showing how to save refreshed tokens after they're automatically renewed.
This pattern can be used in GitHub Actions to update secrets when tokens are refreshed.
"""

import os
import logging
from soundcloud_tools.client import Client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def main():
    # Initialize client (will use tokens from environment)
    client = Client()
    
    # Store original tokens to compare later
    original_access_token = client._access_token
    original_refresh_token = client._refresh_token
    
    logger.info("Creating weekly playlist...")
    
    # Your playlist creation logic here
    # The client will automatically refresh tokens if they're expired
    # Example: client.create_playlist(...)
    
    # Check if tokens were refreshed
    if client._access_token != original_access_token:
        logger.info("✓ Access token was refreshed during operation")
        
        # In GitHub Actions, you could update secrets here
        # For now, just print them (in Actions, you'd use github-script or API)
        print(f"\n{'='*80}")
        print("UPDATED TOKENS - Save these to GitHub Secrets:")
        print(f"{'='*80}")
        print(f"SOUNDCLOUD_ACCESS_TOKEN: {client._access_token}")
        print(f"SOUNDCLOUD_REFRESH_TOKEN: {client._refresh_token}")
        print(f"{'='*80}\n")
        
        # Could also write to a file that GitHub Actions can read
        with open('.tokens_updated', 'w') as f:
            f.write(f"ACCESS_TOKEN={client._access_token}\n")
            f.write(f"REFRESH_TOKEN={client._refresh_token}\n")
    else:
        logger.info("✓ Tokens still valid, no refresh needed")

if __name__ == "__main__":
    main()
