#!/usr/bin/env python3
"""
Parse Playwright Response

This module provides a class to parse and process responses from the Playwright service,
converting HTML content to markdown and handling various error cases.
"""

import json
import re
import logging
import os
from typing import Dict, Any, Optional, Tuple, List
from bs4 import BeautifulSoup
import html2text
import requests
from urllib.parse import urlparse, urljoin

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

class PlaywrightResponseError(Exception):
    """Exception raised for errors in the Playwright response."""
    pass

class PlaywrightParser:
    """
    A class to parse and process Playwright service responses.
    
    This class handles the conversion of HTML content to markdown,
    extraction of links and metadata, and error handling.
    """
    
    def __init__(self, playwright_url: Optional[str] = None):
        """
        Initialize the PlaywrightParser.
        
        Args:
            playwright_url: URL of the Playwright service. If None, will use environment variable.
        """
        self.playwright_url = playwright_url or os.environ.get(
            "PLAYWRIGHT_MICROSERVICE_URL", 
            "https://playwright-service-firecrawl-simple-475988465347.us-west2.run.app/scrape"
        )
        
        # Configure HTML2Text for markdown conversion
        self.html2text_config = {
            "ignore_links": False,
            "ignore_images": False,
            "ignore_tables": False,
            "body_width": 0,  # Don't wrap text
            "unicode_snob": True,  # Use Unicode instead of ASCII
            "single_line_break": True  # Use single line breaks
        }
        
        # Tags to remove during HTML cleaning
        self.unwanted_tags = [
            'script', 'style', 'iframe', 'noscript', 
            'svg', 'canvas', 'video', 'audio',
            'meta', 'link', 'head'
        ]
        
        # Selectors for elements to remove
        self.unwanted_selectors = [
            '.ad', '.ads', '.advertisement', '.banner', 
            '.cookie-banner', '.popup', '.modal',
            '#ad', '#ads', '#cookie-consent'
        ]
    
    def clean_html(self, html_content: str) -> str:
        """
        Clean HTML content by removing unwanted elements and scripts.
        
        Args:
            html_content: Raw HTML content from Playwright
            
        Returns:
            Cleaned HTML content
        """
        if not html_content:
            return ""
        
        try:
            # Parse HTML with BeautifulSoup
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # Remove unwanted elements
            for tag in self.unwanted_tags:
                for element in soup.find_all(tag):
                    element.decompose()
            
            # Remove elements with certain classes or IDs
            for selector in self.unwanted_selectors:
                for element in soup.select(selector):
                    element.decompose()
            
            # Remove empty elements
            for element in soup.find_all():
                if element.name != 'br' and not element.text.strip() and not element.find_all():
                    element.decompose()
            
            return str(soup)
        except Exception as e:
            logger.error(f"Error cleaning HTML: {str(e)}")
            return html_content
    
    def html_to_markdown(self, html_content: str) -> str:
        """
        Convert HTML content to markdown.
        
        Args:
            html_content: Cleaned HTML content
            
        Returns:
            Markdown formatted content
        """
        if not html_content:
            return ""
        
        try:
            # Configure HTML2Text
            h = html2text.HTML2Text()
            for key, value in self.html2text_config.items():
                setattr(h, key, value)
            
            # Convert to markdown
            markdown = h.handle(html_content)
            
            # Clean up the markdown
            markdown = re.sub(r'\n{3,}', '\n\n', markdown)  # Remove excessive newlines
            markdown = re.sub(r'\[!\[\]\(.*?\)\]\(.*?\)', '', markdown)  # Remove nested image links
            
            return markdown
        except Exception as e:
            logger.error(f"Error converting HTML to markdown: {str(e)}")
            return ""
    
    def extract_metadata(self, response_data: Dict[str, Any], url: str) -> Dict[str, Any]:
        """
        Extract metadata from the response and URL.
        
        Args:
            response_data: The Playwright response data
            url: The original URL that was scraped
            
        Returns:
            Dictionary of metadata
        """
        metadata = {
            "url": url,
            "domain": urlparse(url).netloc,
            "status_code": response_data.get("pageStatusCode", 200),
            "error": response_data.get("pageError", None),
            "timestamp": response_data.get("timestamp", None),
        }
        
        # Try to extract title if available
        try:
            if "content" in response_data and response_data["content"]:
                soup = BeautifulSoup(response_data["content"], 'html.parser')
                title_tag = soup.find('title')
                if title_tag and title_tag.text:
                    metadata["title"] = title_tag.text.strip()
        except Exception as e:
            logger.warning(f"Error extracting title: {str(e)}")
        
        return metadata
    
    def extract_links(self, html_content: str, base_url: str) -> Dict[str, str]:
        """
        Extract all links from HTML content and convert to absolute URLs.
        
        Args:
            html_content: HTML content
            base_url: Base URL for resolving relative links
            
        Returns:
            Dictionary with link text as key and absolute URL as value
        """
        if not html_content:
            return {}
        
        try:
            links = {}
            soup = BeautifulSoup(html_content, 'html.parser')
            
            for a_tag in soup.find_all('a', href=True):
                href = a_tag['href']
                # Skip empty, javascript, and anchor links
                if not href or href.startswith('javascript:') or href == '#':
                    continue
                    
                # Convert relative URLs to absolute
                absolute_url = urljoin(base_url, href)
                
                # Use link text as key, or href if no text
                link_text = a_tag.get_text(strip=True)
                if not link_text:
                    link_text = href
                    
                # Handle duplicate link text by appending a counter
                if link_text in links:
                    counter = 1
                    original_text = link_text
                    while link_text in links:
                        counter += 1
                        link_text = f"{original_text} ({counter})"
                
                links[link_text] = absolute_url
                
            return links
        except Exception as e:
            logger.error(f"Error extracting links: {str(e)}")
            return {}
    
    def parse_response(self, response: str, url: str) -> Dict[str, Any]:
        """
        Parse the Playwright service response and convert HTML to markdown.
        
        Args:
            response: Raw response from the Playwright service
            url: The URL that was scraped
            
        Returns:
            Dictionary containing:
            - success: Boolean indicating if parsing was successful
            - markdown: Markdown content (if successful)
            - metadata: Dictionary of metadata about the page
            - links: Dictionary of links with text as key and URL as value
            - error: Error message (if not successful)
        """
        try:
            # Parse the response as JSON
            if isinstance(response, str):
                try:
                    response_data = json.loads(response)
                except json.JSONDecodeError:
                    # If the response is not valid JSON but contains HTML, try to process it directly
                    if "<html" in response.lower():
                        response_data = {"content": response}
                    else:
                        raise PlaywrightResponseError(f"Invalid response format: {response[:100]}...")
            elif isinstance(response, dict):
                response_data = response
            else:
                raise PlaywrightResponseError(f"Unexpected response type: {type(response)}")
            
            # Check if there's an error in the response
            if "pageError" in response_data and response_data["pageError"]:
                return {
                    "success": False,
                    "markdown": "",
                    "metadata": self.extract_metadata(response_data, url),
                    "links": {},
                    "error": response_data["pageError"]
                }
            
            # Check if content exists
            if "content" not in response_data or not response_data["content"]:
                return {
                    "success": False,
                    "markdown": "",
                    "metadata": self.extract_metadata(response_data, url),
                    "links": {},
                    "error": "No content in response"
                }
            
            # Process the HTML content
            html_content = response_data["content"]
            
            # Extract links before cleaning HTML
            links = self.extract_links(html_content, url)
            
            cleaned_html = self.clean_html(html_content)
            markdown_content = self.html_to_markdown(cleaned_html)
            
            # Return the processed content
            return {
                "success": True,
                "markdown": markdown_content,
                "metadata": self.extract_metadata(response_data, url),
                "links": links,
                "error": None
            }
        
        except PlaywrightResponseError as e:
            logger.error(f"Playwright response error: {str(e)}")
            return {
                "success": False,
                "markdown": "",
                "metadata": {"url": url},
                "links": {},
                "error": str(e)
            }
        except Exception as e:
            logger.error(f"Error parsing Playwright response: {str(e)}")
            return {
                "success": False,
                "markdown": "",
                "metadata": {"url": url},
                "links": {},
                "error": f"Unexpected error: {str(e)}"
            }
    
    def call_service(self, url: str, token: Optional[str] = None, wait_after_load: int = 2000) -> Dict[str, Any]:
        """
        Call the Playwright service and parse the response.
        
        Args:
            url: URL to scrape
            token: Authentication token (optional)
            wait_after_load: Time to wait after page load in milliseconds
            
        Returns:
            Parsed response with markdown content
        """
        try:
            # Set up headers
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            
            # Make the request to the Playwright service
            response = requests.post(
                self.playwright_url,
                json={
                    "url": url,
                    "wait_after_load": wait_after_load,
                    "waitUntil": "networkidle"
                },
                headers=headers,
                timeout=60
            )
            
            # Check if the request was successful
            if response.status_code != 200:
                return {
                    "success": False,
                    "markdown": "",
                    "metadata": {"url": url},
                    "links": {},
                    "error": f"Playwright service returned status code {response.status_code}"
                }
            
            # Parse the response
            return self.parse_response(response.text, url)
        
        except requests.RequestException as e:
            logger.error(f"Request to Playwright service failed: {str(e)}")
            return {
                "success": False,
                "markdown": "",
                "metadata": {"url": url},
                "links": {},
                "error": f"Request to Playwright service failed: {str(e)}"
            }


# Backward compatibility functions
def parse_playwright_response(response: str, url: str) -> Dict[str, Any]:
    """
    Legacy function for backward compatibility.
    Parse the Playwright service response and convert HTML to markdown.
    
    Args:
        response: Raw response from the Playwright service
        url: The URL that was scraped
        
    Returns:
        Dictionary containing processed content
    """
    parser = PlaywrightParser()
    return parser.parse_response(response, url)


def call_playwright_service(url: str, token: Optional[str] = None, wait_after_load: int = 2000) -> Dict[str, Any]:
    """
    Legacy function for backward compatibility.
    Call the Playwright service and parse the response.
    
    Args:
        url: URL to scrape
        token: Authentication token (optional)
        wait_after_load: Time to wait after page load in milliseconds
        
    Returns:
        Parsed response with markdown content
    """
    parser = PlaywrightParser()
    return parser.call_service(url, token, wait_after_load)


# Example usage
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        test_url = sys.argv[1]
    else:
        test_url = "https://www.nestedbean.com/pages/faq"
    
    # Get token from environment or gcloud
    token = os.environ.get("PLAYWRIGHT_TOKEN")
    if not token:
        try:
            import subprocess
            token = subprocess.check_output(["gcloud", "auth", "print-identity-token"]).decode().strip()
        except Exception as e:
            print(f"Could not get authentication token: {str(e)}")
            token = None
    
    # Create parser and call service
    parser = PlaywrightParser()
    result = parser.call_service(test_url, token)
    
    # Print the result
    if result["success"]:
        print(f"Successfully scraped {test_url}")
        print(f"Title: {result['metadata'].get('title', 'No title')}")
        print(f"Markdown length: {len(result['markdown'])} characters")
        print(f"Found {len(result['links'])} links")
        print("\nPreview of markdown content:")
        print(result["markdown"][:500] + "...")
    else:
        print(f"Failed to scrape {test_url}")
        print(f"Error: {result['error']}")
