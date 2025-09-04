/**
 * Shared Navigation Utilities
 * Centralized navigation components for use across all pages
 */

class SharedNav {
    
    /**
     * Generate the standard navigation menu
     */
    static generateNavMenu(currentPage = '') {
        const user = SharedAuth.getCurrentUser();
        const userEmail = user.email || 'Unknown';
        const displayEmail = userEmail.length > 20 ? userEmail.substring(0, 17) + '...' : userEmail;

        return `
            <div class="sidebar">
                <div class="logo">
                    <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M19.2747 11.3476L23.722 14.1546C23.9508 14.7206 24.0774 15.3443 24.0774 15.9994C24.0774 16.6546 23.9508 17.2782 23.7221 17.8441L19.2745 20.6513C17.0445 20.4294 15.299 18.4314 15.299 15.9994C15.299 13.5675 17.0445 11.5695 19.2747 11.3476Z" fill="#DBFC01"/>
                        <path d="M7.92285 23.9597L7.92285 18.2668C8.72529 17.1564 9.98604 16.4409 11.4038 16.4409C13.8279 16.4409 15.793 18.5328 15.793 21.1132C15.793 21.8281 15.6422 22.5054 15.3726 23.1112L11.1479 25.7777C9.83493 25.6974 8.67667 25.0027 7.92285 23.9597Z" fill="#DBFC01"/>
                        <path d="M11.1475 6.22217L15.3727 8.88895C15.6422 9.49465 15.793 10.1719 15.793 10.8867C15.793 13.4671 13.8279 15.559 11.4038 15.559C9.98604 15.559 8.72529 14.8434 7.92285 13.7331L7.92285 8.04022C8.67661 6.99725 9.83475 6.30262 11.1475 6.22217Z" fill="#DBFC01"/>
                    </svg>
                    Scope3
                </div>
                
                <nav>
                    <a href="/stories" class="nav-item ${currentPage === 'stories' ? 'active' : ''}">
                        🏠 Stories
                    </a>
                    <a href="/create" class="nav-item ${currentPage === 'create' ? 'active' : ''}">
                        ✨ Create Story
                    </a>
                    <a href="/keyword-analysis" class="nav-item ${currentPage === 'keyword-analysis' ? 'active' : ''}">
                        🔄 Keyword Migration
                    </a>
                    <a href="/sales-agents" class="nav-item ${currentPage === 'sales-agents' ? 'active' : ''}">
                        🎯 ADCP Sales Agents
                    </a>
                </nav>
                
                <div class="user-info">
                    <div class="ui-language-selector">
                        <label for="globalUILanguageSelect" style="font-size: 12px; color: rgba(255, 255, 255, 0.7); display: block; margin-bottom: 4px;">Interface:</label>
                        <select id="globalUILanguageSelect" style="width: 100%; padding: 4px 8px; font-size: 12px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.1); color: white;">
                            <option value="English">English</option>
                            <option value="Dutch">Nederlands</option>
                            <option value="German">Deutsch</option>
                            <option value="Spanish">Español</option>
                            <option value="French">Français</option>
                            <option value="Italian">Italiano</option>
                        </select>
                    </div>
                    <div class="user-email" style="margin-top: 10px;">${displayEmail}</div>
                    <button class="sign-out-btn" onclick="SharedAuth.signOut()">Sign Out</button>
                </div>
            </div>
        `;
    }

    /**
     * Generate the standard CSS for navigation
     */
    static generateNavCSS() {
        return `
            .sidebar {
                width: 200px;
                background-color: #1a4d3a;
                color: white;
                padding: 20px;
                box-sizing: border-box;
                height: 100vh;
                display: flex;
                flex-direction: column;
            }
            
            .logo {
                display: flex;
                align-items: center;
                margin-bottom: 30px;
                font-size: 18px;
                font-weight: 600;
            }
            
            .logo svg {
                margin-right: 10px;
            }
            
            .nav-item {
                display: block;
                color: rgba(255, 255, 255, 0.8);
                text-decoration: none;
                padding: 12px 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                transition: color 0.2s;
            }
            
            .nav-item:hover, .nav-item.active {
                color: white;
            }
            
            nav {
                flex: 1;
                margin-bottom: 20px;
            }
            
            .user-info {
                margin-top: auto;
            }
            
            .user-email {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.7);
                margin-bottom: 8px;
                word-break: break-all;
            }
            
            .sign-out-btn {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: white;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
                width: 100%;
                transition: background-color 0.2s;
            }
            
            .sign-out-btn:hover {
                background: rgba(255, 255, 255, 0.2);
            }
        `;
    }

    /**
     * Mobile navigation menu
     */
    static generateMobileNav(currentPage = '') {
        const user = SharedAuth.getCurrentUser();
        
        if (user.isAuthenticated) {
            const userEmail = user.email || 'Unknown';
            const displayEmail = userEmail.length > 20 ? userEmail.substring(0, 17) + '...' : userEmail;
            
            return `
                <div class="mobile-nav">
                    <div class="mobile-header">
                        <div class="mobile-logo">Scope3</div>
                        <div class="mobile-auth">
                            <div class="user-email">${displayEmail}</div>
                            <button class="auth-btn" onclick="SharedAuth.signOut()">Sign Out</button>
                        </div>
                    </div>
                    <nav class="mobile-menu">
                        <a href="/stories" class="nav-item ${currentPage === 'stories' ? 'active' : ''}">🏠 Stories</a>
                        <a href="/create" class="nav-item ${currentPage === 'create' ? 'active' : ''}">✨ Create Story</a>
                        <a href="/keyword-analysis" class="nav-item ${currentPage === 'keyword-analysis' ? 'active' : ''}">🔄 Keyword Migration</a>
                        <a href="/sales-agents" class="nav-item ${currentPage === 'sales-agents' ? 'active' : ''}">🎯 ADCP Sales Agents</a>
                    </nav>
                </div>
            `;
        } else {
            return `
                <div class="mobile-nav">
                    <div class="mobile-header">
                        <div class="mobile-logo">Scope3</div>
                        <div class="mobile-auth">
                            <button class="auth-btn" onclick="SharedAuth.redirectToAuth()">Sign In</button>
                        </div>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Mobile navigation CSS
     */
    static generateMobileNavCSS() {
        return `
            .mobile-nav {
                display: none;
                background-color: #1a4d3a;
                color: white;
                padding: 15px;
            }
            
            .mobile-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
            }
            
            .mobile-logo {
                font-size: 18px;
                font-weight: 600;
            }
            
            .mobile-auth {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            
            .mobile-menu {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            
            .mobile-menu .nav-item {
                padding: 8px 12px;
                border-radius: 4px;
                transition: background-color 0.2s;
            }
            
            .mobile-menu .nav-item:hover,
            .mobile-menu .nav-item.active {
                background-color: rgba(255, 255, 255, 0.1);
            }
            
            .auth-btn {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: white;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
                transition: background-color 0.2s;
            }
            
            .auth-btn:hover {
                background: rgba(255, 255, 255, 0.2);
            }
            
            @media (max-width: 768px) {
                .sidebar {
                    display: none;
                }
                
                .mobile-nav {
                    display: block;
                }
                
                .main-content {
                    margin-left: 0;
                }
            }
        `;
    }

    /**
     * Update user info in the sidebar
     */
    static updateUserInfo() {
        const userEmailElement = document.querySelector('.user-info .user-email');
        if (!userEmailElement) return;
        
        try {
            const user = SharedAuth.getCurrentUser();
            if (user.isAuthenticated && user.email) {
                const userEmail = user.email;
                const displayEmail = userEmail.length > 20 ? userEmail.substring(0, 17) + '...' : userEmail;
                userEmailElement.textContent = displayEmail;
            } else {
                userEmailElement.textContent = 'Not logged in';
            }
        } catch (error) {
            console.error('Error updating user info:', error);
            userEmailElement.textContent = 'Error loading user';
        }
    }

    /**
     * Generate just the mobile auth controls (no navigation menu)
     */
    static generateMobileAuthOnly() {
        const user = SharedAuth.getCurrentUser();
        
        if (user.isAuthenticated) {
            const userEmail = user.email || 'Unknown';
            const displayEmail = userEmail.length > 20 ? userEmail.substring(0, 17) + '...' : userEmail;
            
            return `
                <div class="user-email">${displayEmail}</div>
                <button class="auth-btn" onclick="SharedAuth.signOut()">Sign Out</button>
            `;
        } else {
            return `
                <button class="auth-btn" onclick="SharedAuth.redirectToAuth()">Sign In</button>
            `;
        }
    }

    /**
     * Initialize navigation for a page
     */
    static initializeNav(currentPage = '', options = {}) {
        const { 
            useMobile = true, 
            useSidebar = true,
            containerId = null 
        } = options;

        // Add CSS if not already present
        if (!document.getElementById('shared-nav-styles')) {
            const style = document.createElement('style');
            style.id = 'shared-nav-styles';
            style.textContent = SharedNav.generateNavCSS() + (useMobile ? SharedNav.generateMobileNavCSS() : '');
            document.head.appendChild(style);
        }

        // Add navigation HTML
        if (useSidebar) {
            const navContainer = containerId ? document.getElementById(containerId) : document.body;
            if (navContainer) {
                // Insert sidebar at the beginning
                navContainer.insertAdjacentHTML('afterbegin', SharedNav.generateNavMenu(currentPage));
            }
        }

        if (useMobile) {
            const navContainer = containerId ? document.getElementById(containerId) : document.body;
            if (navContainer) {
                // Insert mobile nav at the beginning
                navContainer.insertAdjacentHTML('afterbegin', SharedNav.generateMobileNav(currentPage));
            }
        }
    }

    /**
     * Global UI Language Management
     */
    static initializeGlobalUILanguage() {
        // Auto-detect browser language
        SharedNav.detectBrowserLanguage();
        
        // Initialize change listener
        const languageSelect = document.getElementById('globalUILanguageSelect');
        if (languageSelect) {
            languageSelect.addEventListener('change', function() {
                const selectedLanguage = this.value;
                SharedNav.setGlobalUILanguage(selectedLanguage);
                SharedNav.updateGlobalUILanguage();
                
                // Trigger custom event for pages to listen to
                window.dispatchEvent(new CustomEvent('globalUILanguageChanged', {
                    detail: { language: selectedLanguage }
                }));
            });
        }
        
        // Apply current language
        SharedNav.updateGlobalUILanguage();
    }

    static detectBrowserLanguage() {
        const browserLang = navigator.language || navigator.userLanguage;
        const langCode = browserLang.toLowerCase().split('-')[0];
        
        const langMap = {
            'nl': 'Dutch',
            'de': 'German', 
            'es': 'Spanish',
            'fr': 'French',
            'it': 'Italian'
        };
        
        const detectedLanguage = langMap[langCode] || 'English';
        
        // Only set if no language is already stored
        if (!localStorage.getItem('globalUILanguage')) {
            SharedNav.setGlobalUILanguage(detectedLanguage);
        }
        
        // Update dropdown to reflect current language
        const languageSelect = document.getElementById('globalUILanguageSelect');
        if (languageSelect) {
            languageSelect.value = SharedNav.getGlobalUILanguage();
        }
    }

    static getGlobalUILanguage() {
        return localStorage.getItem('globalUILanguage') || 'English';
    }

    static setGlobalUILanguage(language) {
        localStorage.setItem('globalUILanguage', language);
    }

    static updateGlobalUILanguage() {
        const selectedLanguage = SharedNav.getGlobalUILanguage();
        
        // Update document language attribute
        const langCodes = {
            'English': 'en',
            'Dutch': 'nl', 
            'German': 'de',
            'Spanish': 'es',
            'French': 'fr',
            'Italian': 'it'
        };
        
        document.documentElement.lang = langCodes[selectedLanguage] || 'en';
        
        // Update dropdown if it exists
        const languageSelect = document.getElementById('globalUILanguageSelect');
        if (languageSelect && languageSelect.value !== selectedLanguage) {
            languageSelect.value = selectedLanguage;
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SharedNav;
}

// Make available globally for direct script inclusion
window.SharedNav = SharedNav;