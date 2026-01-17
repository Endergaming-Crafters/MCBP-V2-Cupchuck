// MCBP V2 Common JavaScript Utilities

// Theme Management
function applyTheme(theme) {
    if (theme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.classList.toggle('light-theme', !prefersDark);
    } else {
        document.body.classList.toggle('light-theme', theme === 'light');
    }
}

function getStoredTheme() {
    return localStorage.getItem('mcbp-theme') || 'auto';
}

function setStoredTheme(theme) {
    localStorage.setItem('mcbp-theme', theme);
    applyTheme(theme);
}

// Authentication
function getAuthToken() {
    return localStorage.getItem('mcbp-token');
}

function getCurrentUser() {
    const userStr = localStorage.getItem('mcbp-user');
    return userStr ? JSON.parse(userStr) : null;
}

function isAuthenticated() {
    return !!getAuthToken();
}

function redirectToLogin() {
    // Only redirect if we're not already on the login page
    const isLoginPage = window.location.pathname.includes('index.html') || 
                       window.location.pathname === '/' ||
                       window.location.pathname.endsWith('/');
    
    if (!isAuthenticated() && !isLoginPage) {
        window.location.href = '/';
    }
}

// API Helpers
async function apiRequest(endpoint, options = {}) {
    const token = getAuthToken();
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            'x-auth-token': token
        }
    };

    const response = await fetch(endpoint, { ...defaultOptions, ...options });
    
    if (response.status === 401) {
        // Token expired or invalid
        localStorage.clear();
        
        // Only redirect if not on login page
        const isLoginPage = window.location.pathname.includes('index.html') || 
                           window.location.pathname === '/' ||
                           window.location.pathname.endsWith('/');
        
        if (!isLoginPage) {
            window.location.href = '/';
        }
        return null;
    }
    
    return response.json();
}

// Toast Notifications
function showToast(message, type = 'info', duration = 5000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-content">
            <i class="fas fa-${getToastIcon(type)}"></i>
            <span>${message}</span>
        </div>
    `;
    
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.remove();
    }, duration);
    
    return toast;
}

function getToastIcon(type) {
    switch(type) {
        case 'success': return 'check-circle';
        case 'error': return 'exclamation-circle';
        case 'warning': return 'exclamation-triangle';
        default: return 'info-circle';
    }
}

// Date Formatting
function formatDate(dateString, options = {}) {
    if (!dateString) return '-';
    
    const date = new Date(dateString);
    const defaultOptions = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    };
    
    return date.toLocaleString(undefined, { ...defaultOptions, ...options });
}

function formatRelativeTime(dateString) {
    if (!dateString) return 'Never';
    
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
}

// Validation
function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

// Local Storage Helpers
function storeObject(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function getObject(key, defaultValue = null) {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
}

// DOM Helpers
function createElement(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);
    
    // Set attributes
    Object.entries(attributes).forEach(([key, value]) => {
        if (key === 'className') {
            element.className = value;
        } else if (key === 'textContent') {
            element.textContent = value;
        } else if (key === 'innerHTML') {
            element.innerHTML = value;
        } else {
            element.setAttribute(key, value);
        }
    });
    
    // Append children
    children.forEach(child => {
        if (typeof child === 'string') {
            element.appendChild(document.createTextNode(child));
        } else if (child instanceof Node) {
            element.appendChild(child);
        }
    });
    
    return element;
}

function toggleElementVisibility(elementId, show) {
    const element = document.getElementById(elementId);
    if (element) {
        element.classList.toggle('hidden', !show);
    }
}

// Debounce function for search/input events
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Throttle function for scroll/resize events
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// Copy to clipboard
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(
        () => showToast('Copied to clipboard', 'success'),
        () => showToast('Failed to copy', 'error')
    );
}

// Generate random ID
function generateId(prefix = '') {
    return prefix + Math.random().toString(36).substr(2, 9);
}

// Parse URL parameters
function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const result = {};
    for (const [key, value] of params) {
        result[key] = value;
    }
    return result;
}

// Check if running on mobile
function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

// Permission checking with custom message
function checkPermission(permission) {
    const user = getCurrentUser();
    if (!user) {
        showToast('You must be logged in to perform this action', 'error');
        return false;
    }
    
    if (user.permissions.includes('*') || user.permissions.includes(permission)) {
        return true;
    }
    
    showToast(`You do not have the permission '${permission}' to use this action.`, 'error');
    return false;
}

// Initialize theme on page load
document.addEventListener('DOMContentLoaded', () => {
    const theme = getStoredTheme();
    applyTheme(theme);
    
    // Auto-check authentication on protected pages (EXCEPT login page)
    const isLoginPage = window.location.pathname.includes('index.html') || 
                       window.location.pathname === '/' ||
                       window.location.pathname.endsWith('/');
    
    if (!isLoginPage) {
        redirectToLogin();
    }
});

// Export for Node.js compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        applyTheme,
        getAuthToken,
        getCurrentUser,
        showToast,
        formatDate,
        formatRelativeTime,
        isValidEmail,
        isValidUrl,
        generateId,
        getUrlParams,
        isMobile,
        checkPermission
    };
}