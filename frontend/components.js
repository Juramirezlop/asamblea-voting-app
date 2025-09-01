/**
 * COMPONENTES REUTILIZABLES
 * Sistema de componentes modular para la aplicación de votación
 */

// ================================
// SISTEMA DE NOTIFICACIONES
// ================================

class NotificationSystem {
    constructor() {
        this.container = document.getElementById('notification-container');
        this.notifications = new Map();
        this.nextId = 1;
    }

    show(message, type = 'info', duration = 4000, title = '') {
        const id = this.nextId++;
        const notification = this.createNotification(id, message, type, title);
        
        this.container.appendChild(notification);
        this.notifications.set(id, notification);

        // Animar entrada
        requestAnimationFrame(() => {
            notification.classList.add('show');
        });

        // Auto-remove
        if (duration > 0) {
            setTimeout(() => {
                this.hide(id);
            }, duration);
        }

        return id;
    }

    createNotification(id, message, type, title) {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.dataset.id = id;

        const icons = {
            success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22,4 12,14.01 9,11.01"></polyline></svg>',
            error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
        };

        notification.innerHTML = `
            <div class="notification-icon">${icons[type] || icons.info}</div>
            <div class="notification-content">
                ${title ? `<div class="notification-title">${title}</div>` : ''}
                <div class="notification-message">${message}</div>
            </div>
            <button class="notification-close" onclick="notifications.hide(${id})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        `;

        return notification;
    }

    hide(id) {
        const notification = this.notifications.get(id);
        if (notification) {
            notification.classList.remove('show');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
                this.notifications.delete(id);
            }, 300);
        }
    }

    clear() {
        this.notifications.forEach((notification, id) => {
            this.hide(id);
        });
    }
}

// ================================
// SISTEMA DE MODALES
// ================================

class ModalSystem {
    constructor() {
        this.container = document.getElementById('modal-container');
        this.activeModal = null;
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Cerrar modal con Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.activeModal) {
                this.hide();
            }
        });

        // Cerrar modal clickeando fuera
        this.container.addEventListener('click', (e) => {
            if (e.target === this.activeModal) {
                this.hide();
            }
        });
    }

    show(config) {
        const modal = this.createModal(config);
        this.container.appendChild(modal);
        this.activeModal = modal;

        // Animar entrada
        requestAnimationFrame(() => {
            modal.classList.add('show');
        });

        // Focus en primer input si existe
        const firstInput = modal.querySelector('input, textarea, select');
        if (firstInput) {
            setTimeout(() => firstInput.focus(), 100);
        }

        return modal;
    }

    createModal(config) {
        const {
            title = '',
            content = '',
            actions = [],
            size = 'medium',
            closable = true
        } = config;

        const modal = document.createElement('div');
        modal.className = `modal-overlay ${size}`;
        if (size === 'large') {
            modal.style.padding = '2rem';
        }

        const actionsHTML = actions.map(action => 
            `<button class="btn ${action.class || 'btn-secondary'}" 
                     onclick="${action.handler}" 
                     ${action.disabled ? 'disabled' : ''}>
                ${action.text}
             </button>`
        ).join('');

        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>${title}</h3>
                    ${closable ? `
                        <button class="modal-close" onclick="modals.hide()">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    ` : ''}
                </div>
                <div class="modal-body">
                    ${content}
                </div>
                ${actions.length ? `
                    <div class="modal-actions">
                        ${actionsHTML}
                    </div>
                ` : ''}
            </div>
        `;

        return modal;
    }

    hide() {
        if (this.activeModal && this.activeModal.parentNode) {
            this.activeModal.classList.remove('show');            
            this.cleanupModalState();
            
            setTimeout(() => {
                if (this.activeModal && this.activeModal.parentNode) {
                    this.activeModal.parentNode.removeChild(this.activeModal);
                }
                this.activeModal = null;
            }, 300);
        }
    }

    cleanupModalState() {
        // Lista de funciones seguras para limpiar
        const functionsToClean = [
            'changePage', 'filterParticipants', 'saveConjuntoName',
            'confirmAttendanceRegistration', 'saveEditedVoting',
            'saveVoterChanges', 'saveVoteEdit'
        ];
        
        functionsToClean.forEach(fn => {
            try {
                if (window.hasOwnProperty(fn)) {
                    delete window[fn];
                }
            } catch (error) {
                // Silenciar errores de propiedades no configurables
            }
        });
    }

    confirm(message, title = 'Confirmar acción') {
        return new Promise((resolve) => {
            // Limpiar resolver previo
            if (window.modalResolve) {
                window.modalResolve(false); // Resolver pendiente como false
            }
            
            this.show({
                title,
                content: `<p style="margin: 1rem 0; text-align: center;">${message}</p>`,
                actions: [
                    {
                        text: 'Cancelar',
                        class: 'btn-secondary',
                        handler: `modals.hide(); if(window.modalResolve) { window.modalResolve(false); delete window.modalResolve; }`
                    },
                    {
                        text: 'Confirmar',
                        class: 'btn-danger',
                        handler: `modals.hide(); if(window.modalResolve) { window.modalResolve(true); delete window.modalResolve; }`
                    }
                ]
            });

            window.modalResolve = resolve;
            
            setTimeout(() => {
                if (window.modalResolve === resolve) {
                    resolve(false);
                    delete window.modalResolve;
                }
            }, 10000);
        });
    }

    prompt(message, defaultValue = '', title = 'Ingrese información') {
        return new Promise((resolve) => {
            this.show({
                title,
                content: `
                    <p>${message}</p>
                    <input type="text" class="modal-input" id="modal-prompt-input" value="${defaultValue}">
                `,
                actions: [
                    {
                        text: 'Cancelar',
                        class: 'btn-secondary',
                        handler: `modals.hide(); window.modalResolve(null);`
                    },
                    {
                        text: 'Aceptar',
                        class: 'btn-primary',
                        handler: `
                            const value = document.getElementById('modal-prompt-input').value;
                            modals.hide(); 
                            window.modalResolve(value);
                        `
                    }
                ]
            });

            window.modalResolve = resolve;
        });
    }
}

// ================================
// COMPONENTES DE VOTACIÓN
// ================================

class VotingComponents {
    static createYesNoVoting(question) {
        return `
            <div class="voting-card" data-question-id="${question.id}">
                <div class="question-header">
                    <div class="question-title">${question.text}</div>
                    <div class="question-meta">
                    ${question.time_remaining_seconds !== null && question.time_remaining_seconds !== undefined ? `
                        <div class="question-timer" data-question-id="${question.id}" data-remaining="${question.time_remaining_seconds}">
                            ⏰ ${Math.floor(question.time_remaining_seconds/60)}:${String(question.time_remaining_seconds%60).padStart(2,'0')} restantes
                        </div>
                    ` : ''}
                        <div class="meta-item">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 3v18h18"></path>
                                <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"></path>
                            </svg>
                            <span>Pregunta Sí/No</span>
                        </div>
                        <div class="meta-item">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="6" x2="12" y2="10"></line>
                                <line x1="12" y1="14" x2="12.01" y2="14"></line>
                            </svg>
                            <span>${question.closed ? 'Cerrada' : 'Abierta'}</span>
                        </div>
                    </div>
                </div>

                ${question.closed ? `
                    <div class="voted-status">
                        🔒 Esta votación ha sido cerrada
                    </div>
                ` : `
                    <div class="yesno-options">
                        <div class="option-btn yes" onclick="voteYesNo(${question.id}, 'SÍ')">
                            <div class="option-icon">✅</div>
                            <div>SÍ</div>
                        </div>
                        <div class="option-btn no" onclick="voteYesNo(${question.id}, 'No')">
                            <div class="option-icon">❌</div>
                            <div>NO</div>
                        </div>
                    </div>
                `}
            </div>
        `;
    }

    static createMultipleVoting(question) {
        const isMultiple = question.allow_multiple && question.max_selections > 1;
        
        return `
            <div class="voting-card" data-question-id="${question.id}">
                <div class="question-header">
                    <div class="question-title">${question.text}</div>
                    <div class="question-meta">
                    ${question.time_remaining_seconds !== null && question.time_remaining_seconds !== undefined ? `
                        <div class="question-timer" data-question-id="${question.id}" data-remaining="${question.time_remaining_seconds}">
                            ⏰ ${Math.floor(question.time_remaining_seconds/60)}:${String(question.time_remaining_seconds%60).padStart(2,'0')} restantes
                        </div>
                    ` : ''}
                        <div class="meta-item">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
                                <path d="M9 7V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path>
                            </svg>
                            <span>${isMultiple ? 'Selección múltiple' : 'Selección única'}</span>
                        </div>
                        <div class="meta-item">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                <circle cx="9" cy="7" r="4"></circle>
                                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                            </svg>
                            <span>${question.options ? question.options.length : 0} opciones</span>
                        </div>
                        ${isMultiple ? `
                            <div class="meta-item">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
                                </svg>
                                <span>Máximo ${question.max_selections}</span>
                            </div>
                        ` : ''}
                    </div>
                </div>

                ${question.closed ? `
                    <div class="voted-status">
                        🔒 Esta votación ha sido cerrada
                    </div>
                ` : `
                    ${isMultiple ? `
                        <div class="selection-info">
                            💡 Puede seleccionar hasta ${question.max_selections} opciones. 
                            Seleccionadas: <span class="selected-count">0</span>/${question.max_selections}
                        </div>
                    ` : ''}

                    <div class="multiple-options">
                        ${question.options ? question.options.map((option, index) => `
                            <div class="multiple-option" 
                                 data-option="${option.text}" 
                                 onclick="selectMultipleOption(this, ${question.id}, ${question.max_selections}, ${isMultiple})">
                                <div class="option-text">${option.text}</div>
                                <div class="option-indicator"></div>
                            </div>
                        `).join('') : ''}
                    </div>

                    <button class="submit-btn" 
                            onclick="submitMultipleVote(${question.id})" 
                            disabled>
                        Confirmar Selección
                    </button>
                `}
            </div>
        `;
    }

    static createVotedStatus(question, userAnswer) {
        return `
            <div class="voting-card voted" data-question-id="${question.id}">
                <div class="question-header">
                    <div class="question-title">${question.text}</div>
                    <div class="question-meta">
                        <div class="meta-item">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                                <polyline points="22,4 12,14.01 9,11.01"></polyline>
                            </svg>
                            <span>Voto registrado</span>
                        </div>
                    </div>
                </div>

                <div class="voted-status">
                    ✅ Ya votaste en esta pregunta
                    <div style="margin-top: 0.8rem; font-weight: normal; opacity: 0.9;">
                        Tu respuesta: <strong>${userAnswer}</strong>
                    </div>
                </div>
            </div>
        `;
    }
}

// ================================
// COMPONENTES DE ADMINISTRACIÓN
// ================================

class AdminComponents {
    static createVotingForm() {
        return `
            <div class="create-form">
                <div class="form-header">
                    <h2>⚙️ Nueva Votación</h2>
                    <p>Crea una nueva votación para la asamblea</p>
                </div>

                <div class="form-section">
                    <h3>🎯 Tipo de Votación</h3>
                    <div class="type-selector">
                        <div class="type-option selected" data-type="yesno">
                            <div class="type-icon">✅❌</div>
                            <div class="type-title">Pregunta Sí/No</div>
                            <div class="type-description">Votación simple con dos opciones: Sí o No</div>
                        </div>
                        <div class="type-option" data-type="multiple">
                            <div class="type-icon">🗳️</div>
                            <div class="type-title">Elección Múltiple</div>
                            <div class="type-description">Votación con múltiples candidatos u opciones</div>
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <h3>📝 Pregunta</h3>
                    <label class="form-label">Escriba la pregunta o cargo a elegir</label>
                    <input type="text" 
                           class="form-input" 
                           id="question-text" 
                           placeholder="¿Aprueba la propuesta de mejoras en las zonas comunes?">
                </div>

                <!-- Configuración de timer para encuestas -->
                <div class="form-section">
                    <h3>⏰ Tiempo Límite</h3>
                    
                    <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                        <input type="checkbox" id="enable-timer" style="transform: scale(1.2);">
                        <label for="enable-timer" style="font-weight: 500;">Establecer tiempo límite para esta votación</label>
                    </div>
                    
                    <div id="timer-config" style="display: none; padding: 1rem; background: rgba(245, 158, 11, 0.1); border-radius: 8px;">
                        <label class="form-label">Minutos disponibles para votar:</label>
                        <input type="number" id="time-limit-minutes" class="form-input" 
                               value="15" min="1" max="180" style="width: 120px;">
                        <p style="color: var(--gray-600); font-size: 0.9rem; margin-top: 0.5rem;">
                            La votación se cerrará automáticamente después de este tiempo
                        </p>
                    </div>
                </div>

                <!-- Configuración para Múltiples Opciones -->
                <div class="selection-config" id="multiple-config">
                    <h3>⚙️ Configuración de Selección</h3>
                    
                    <div class="selection-toggle">
                        <button type="button" class="toggle-btn active" data-mode="single">
                            🎯 Selección Única
                        </button>
                        <button type="button" class="toggle-btn" data-mode="multiple">
                            ✨ Selección Múltiple
                        </button>
                    </div>

                    <div class="config-row" id="max-selections-row" style="display: none;">
                        <span class="config-label">Máximo selecciones:</span>
                        <input type="number" 
                               class="config-input" 
                               id="max-selections" 
                               value="1" 
                               min="1" 
                               disabled>
                        <span class="config-hint">Cuántas opciones puede elegir cada votante</span>
                    </div>
                </div>

                <!-- Lista de Opciones -->
                <div class="options-section" id="options-section">
                    <h3>📋 Opciones de Votación</h3>
                    
                    <div class="options-list" id="options-list">
                        <!-- Las opciones se agregan dinámicamente -->
                    </div>

                    <div class="add-option" onclick="addNewOption()">
                        <span style="font-size: 1.5rem;">➕</span>
                        <span>Agregar nueva opción</span>
                    </div>
                </div>

                <button class="btn btn-primary create-btn" onclick="createNewVoting()">
                    🚀 Crear y Activar Votación
                </button>
            </div>
        `;
    }

    static createOptionItem(number, text = '') {
        return `
            <div class="option-item" data-option-number="${number}">
                <div class="option-number">${number}</div>
                <input type="text" 
                       class="form-input option-text" 
                       placeholder="Nombre del candidato u opción"
                       value="${text}">
                <button class="remove-option" onclick="removeOptionItem(this)" type="button">×</button>
            </div>
        `;
    }

    static createActiveVotingCard(question) {
        const typeText = question.type === 'yesno' ? 'Sí/No' : 
                        (question.allow_multiple ? 'Selección múltiple' : 'Selección única');
        
        return `
            <div class="voting-card admin-card" data-question-id="${question.id}">
                <div class="voting-header">
                    <div class="voting-title">${question.text}</div>
                    <div class="voting-status ${question.closed ? 'closed' : 'open'}">
                        ${question.closed ? '🔒 Cerrada' : '🟢 Abierta'}
                    </div>
                </div>
                
                <div class="voting-meta">
                    <div class="meta-item">
                        <span>📊</span>
                        <span>Tipo: ${typeText}</span>
                    </div>
                    <div class="meta-item">
                        <span>🗳️</span>
                        <span>Votos: <span class="vote-count" data-question-id="${question.id}">Cargando...</span></span>
                    </div>
                    <div class="meta-item">
                        <span>⏱️</span>
                        <span>Estado: ${question.closed ? 'Finalizada' : 'En progreso'}</span>
                    </div>
                </div>

                <div class="voting-options-preview">
                    <h4>Opciones:</h4>
                    <div class="options-tags">
                        ${question.options ? question.options.map(opt => 
                            `<span class="option-tag">${opt.text}</span>`
                        ).join('') : ''}
                    </div>
                </div>

                <div class="voting-actions">
                    <button class="btn ${question.closed ? 'btn-success' : 'btn-warning'}" 
                            onclick="toggleVotingStatus(${question.id})">
                        ${question.closed ? '▶️ Abrir' : '⏸️ Cerrar'}
                    </button>
                    
                    <button class="btn btn-info" onclick="viewVotingResults(${question.id})">
                        📊 Ver Resultados
                    </button>

                    ${!question.closed && question.expires_at ? `
                        <button class="btn btn-warning" onclick="showExtendTimeModal(${question.id}, '${question.text}')">
                            ⏰ Extender Tiempo
                        </button>
                    ` : ''}
                    
                    ${question.closed ? `
                        <button class="btn btn-secondary" onclick="editVoting(${question.id})">
                            ✏️ Editar
                        </button>
                    ` : ''}
                    
                    <button class="btn btn-danger" onclick="deleteVoting(${question.id})">
                        🗑️ Eliminar
                    </button>
                </div>
            </div>
        `;
    }

    static createActiveQuestionsContainer(questions) {
        if (questions.length === 0) {
            return `
                <div style="text-align: center; padding: 3rem; color: var(--gray-600);">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 1rem; opacity: 0.5;">
                        <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
                        <path d="M9 7V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path>
                    </svg>
                    <h3 style="margin-bottom: 0.5rem; color: var(--gray-700);">No hay votaciones creadas</h3>
                    <p>Cree una nueva votación usando el formulario de arriba</p>
                </div>
            `;
        }

        return questions.map(q => AdminComponents.createActiveVotingCard(q)).join('');
    }

}

// ================================
// UTILIDADES Y HELPERS
// ================================

class Utils {
    static formatCode(code) {
        // Formatear código de apartamento
        return code.toUpperCase().replace(/[^0-9-]/g, '');
    }

    static validateCode(code) {
        const regex = /^\d+-\d+$/;
        return regex.test(code);
    }

    static formatTime(timestamp) {
        if (!timestamp) return '-';
        
        try {
            const date = new Date(timestamp);
            return date.toLocaleString('es-CO', {
                timeZone: 'America/Bogota',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (error) {
            return 'Fecha inválida';
        }
    }

    static debounce(func, wait) {
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

    static throttle(func, limit) {
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

    static sanitizeHTML(str) {
        const temp = document.createElement('div');
        temp.textContent = str;
        return temp.innerHTML;
    }

    static generateId() {
        return 'id_' + Math.random().toString(36).substr(2, 9);
    }

    static copyToClipboard(text) {
        if (navigator.clipboard) {
            return navigator.clipboard.writeText(text);
        } else {
            // Fallback para navegadores antiguos
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            return Promise.resolve();
        }
    }

    static animateNumber(element, start, end, duration = 1000) {
        if (start === end) return;
        
        const range = end - start;
        const increment = end > start ? 1 : -1;
        const stepTime = Math.abs(Math.floor(duration / range));
        const timer = setInterval(() => {
            start += increment;
            element.textContent = start;
            if (start === end) {
                clearInterval(timer);
            }
        }, stepTime);
    }

    static formatPercentage(value, decimals = 2) {
        return `${Number(value).toFixed(decimals)}%`;
    }

    static formatNumber(value, separator = ',') {
        return Number(value).toLocaleString('es-CO');
    }

    static isValidEmail(email) {
        const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return regex.test(email);
    }

    static isValidPhone(phone) {
        const regex = /^[\+]?[1-9][\d]{0,15}$/;
        return regex.test(phone.replace(/\s/g, ''));
    }

    static getRandomColor() {
        const colors = [
            '#667eea', '#764ba2', '#f093fb', '#10b981', 
            '#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6'
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    static scrollToElement(element, behavior = 'smooth') {
        if (typeof element === 'string') {
            element = document.querySelector(element);
        }
        
        if (element) {
            element.scrollIntoView({ behavior, block: 'center' });
        }
    }

    static createRippleEffect(element, event) {
        const rect = element.getBoundingClientRect();
        const ripple = document.createElement('span');
        const size = Math.max(rect.width, rect.height);
        
        ripple.style.cssText = `
            position: absolute;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.6);
            transform: scale(0);
            animation: ripple 0.6s linear;
            pointer-events: none;
            width: ${size}px;
            height: ${size}px;
            left: ${event.clientX - rect.left - size / 2}px;
            top: ${event.clientY - rect.top - size / 2}px;
        `;
        
        element.appendChild(ripple);
        
        setTimeout(() => {
            ripple.remove();
        }, 600);
    }
}

// ================================
// LOADER / LOADING STATES
// ================================

class LoadingManager {
    constructor() {
        this.activeLoaders = new Set();
    }

    show(target, text = 'Cargando...') {
        if (typeof target === 'string') {
            target = document.querySelector(target);
        }
        
        if (!target) return;

        const loaderId = Utils.generateId();
        const loader = document.createElement('div');
        loader.className = 'loading-state';
        loader.dataset.loaderId = loaderId;
        loader.innerHTML = `
            <div class="spinner"></div>
            <p>${text}</p>
        `;

        // Guardar contenido original si no existe
        if (!target.dataset.originalContent) {
            target.dataset.originalContent = target.innerHTML;
        }

        target.innerHTML = '';
        target.appendChild(loader);
        this.activeLoaders.add(loaderId);

        return loaderId;
    }

    hide(target, loaderId = null) {
        if (typeof target === 'string') {
            target = document.querySelector(target);
        }
        
        if (!target) return;

        if (loaderId) {
            const loader = target.querySelector(`[data-loader-id="${loaderId}"]`);
            if (loader) {
                loader.remove();
                this.activeLoaders.delete(loaderId);
            }
        }

        // Restaurar contenido original si no hay más loaders
        const remainingLoaders = target.querySelectorAll('.loading-state');
        if (remainingLoaders.length === 0 && target.dataset.originalContent) {
            target.innerHTML = target.dataset.originalContent;
            delete target.dataset.originalContent;
        }
    }

    hideAll() {
        this.activeLoaders.forEach(loaderId => {
            const loader = document.querySelector(`[data-loader-id="${loaderId}"]`);
            if (loader && loader.parentElement) {
                this.hide(loader.parentElement, loaderId);
            }
        });
        this.activeLoaders.clear();
    }
}

// ================================
// VALIDADOR DE FORMULARIOS
// ================================

class FormValidator {
    constructor(form) {
        this.form = typeof form === 'string' ? document.querySelector(form) : form;
        this.rules = new Map();
        this.errors = new Map();
        this.setupEventListeners();
    }

    setupEventListeners() {
        if (!this.form) return;

        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.validateAll();
        });

        // Validación en tiempo real
        this.form.addEventListener('input', (e) => {
            if (this.rules.has(e.target.name)) {
                this.validateField(e.target);
            }
        });

        this.form.addEventListener('blur', (e) => {
            if (this.rules.has(e.target.name)) {
                this.validateField(e.target);
            }
        }, true);
    }

    addRule(fieldName, validator, message) {
        if (!this.rules.has(fieldName)) {
            this.rules.set(fieldName, []);
        }
        this.rules.get(fieldName).push({ validator, message });
        return this;
    }

    validateField(field) {
        const fieldName = field.name;
        const fieldRules = this.rules.get(fieldName);
        
        if (!fieldRules) return true;

        // Limpiar errores previos
        this.clearFieldError(field);

        // Ejecutar validaciones
        for (const rule of fieldRules) {
            const result = rule.validator(field.value, field);
            if (result !== true) {
                this.showFieldError(field, rule.message);
                this.errors.set(fieldName, rule.message);
                return false;
            }
        }

        this.errors.delete(fieldName);
        return true;
    }

    validateAll() {
        let isValid = true;
        this.errors.clear();

        this.rules.forEach((rules, fieldName) => {
            const field = this.form.querySelector(`[name="${fieldName}"]`);
            if (field && !this.validateField(field)) {
                isValid = false;
            }
        });

        return isValid;
    }

    showFieldError(field, message) {
        field.classList.add('invalid');
        
        // Crear o actualizar mensaje de error
        let errorElement = field.parentElement.querySelector('.field-error');
        if (!errorElement) {
            errorElement = document.createElement('div');
            errorElement.className = 'field-error';
            field.parentElement.appendChild(errorElement);
        }
        errorElement.textContent = message;
    }

    clearFieldError(field) {
        field.classList.remove('invalid');
        const errorElement = field.parentElement.querySelector('.field-error');
        if (errorElement) {
            errorElement.remove();
        }
    }

    clearAllErrors() {
        this.errors.clear();
        this.form.querySelectorAll('.invalid').forEach(field => {
            this.clearFieldError(field);
        });
    }

    getErrors() {
        return Array.from(this.errors.entries());
    }

    hasErrors() {
        return this.errors.size > 0;
    }

    // Validadores comunes
    static validators = {
        required: (value) => value.trim() !== '' || 'Este campo es requerido',
        email: (value) => Utils.isValidEmail(value) || 'Email inválido',
        phone: (value) => Utils.isValidPhone(value) || 'Teléfono inválido',
        minLength: (min) => (value) => value.length >= min || `Mínimo ${min} caracteres`,
        maxLength: (max) => (value) => value.length <= max || `Máximo ${max} caracteres`,
        number: (value) => !isNaN(value) || 'Debe ser un número',
        positive: (value) => parseFloat(value) > 0 || 'Debe ser mayor a 0',
        apartmentCode: (value) => Utils.validateCode(value) || 'Formato inválido (Torre-Apto)',
    };
}

// ================================
// GESTOR DE ESTADO GLOBAL
// ================================

class StateManager {
    constructor() {
        this.state = new Map();
        this.subscribers = new Map();
    }

    set(key, value) {
        const oldValue = this.state.get(key);
        this.state.set(key, value);
        
        // Notificar suscriptores
        if (this.subscribers.has(key)) {
            this.subscribers.get(key).forEach(callback => {
                callback(value, oldValue);
            });
        }
    }

    get(key) {
        return this.state.get(key);
    }

    has(key) {
        return this.state.has(key);
    }

    delete(key) {
        const value = this.state.get(key);
        this.state.delete(key);
        
        // Notificar suscriptores
        if (this.subscribers.has(key)) {
            this.subscribers.get(key).forEach(callback => {
                callback(undefined, value);
            });
        }
    }

    subscribe(key, callback) {
        if (!this.subscribers.has(key)) {
            this.subscribers.set(key, new Set());
        }
        this.subscribers.get(key).add(callback);

        // Retornar función de desuscripción
        return () => {
            const subscribers = this.subscribers.get(key);
            if (subscribers) {
                subscribers.delete(callback);
                if (subscribers.size === 0) {
                    this.subscribers.delete(key);
                }
            }
        };
    }

    clear() {
        this.state.clear();
        this.subscribers.clear();
    }

    getAll() {
        return Object.fromEntries(this.state);
    }
}

// ================================
// INICIALIZAR SISTEMAS GLOBALES
// ================================

// Instanciar sistemas globales
window.notifications = new NotificationSystem();
window.modals = new ModalSystem();
window.loading = new LoadingManager();
window.state = new StateManager();

// Agregar estilos CSS para ripple effect
const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
    @keyframes ripple {
        to {
            transform: scale(4);
            opacity: 0;
        }
    }
    
    .field-error {
        color: var(--danger-color);
        font-size: 0.85rem;
        margin-top: 0.25rem;
        animation: slideDown 0.3s ease;
    }
    
    @keyframes slideDown {
        from {
            opacity: 0;
            transform: translateY(-10px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
    
    .modal-close {
        position: absolute;
        top: 1rem;
        right: 1rem;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0.5rem;
        border-radius: 50%;
        color: var(--gray-600);
        transition: all 0.3s ease;
    }
    
    .modal-close:hover {
        background: var(--gray-100);
        color: var(--gray-800);
    }
    
    .notification-icon {
        color: inherit;
        flex-shrink: 0;
    }
    
    .notification-close {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0.25rem;
        border-radius: 4px;
        color: var(--gray-500);
        flex-shrink: 0;
        margin-left: auto;
    }
    
    .notification-close:hover {
        background: var(--gray-100);
        color: var(--gray-700);
    }
`;
document.head.appendChild(rippleStyle);

// Agregar efectos de ripple a todos los botones
document.addEventListener('DOMContentLoaded', () => {
    // Agregar ripple effect a botones
    document.addEventListener('click', (e) => {
        if (e.target.matches('.btn, .option-btn, .multiple-option')) {
            Utils.createRippleEffect(e.target, e);
        }
    });

    // Validación en tiempo real para input de código
    const accessInput = document.getElementById('access-code');
    if (accessInput) {
        accessInput.addEventListener('input', (e) => {
            const code = e.target.value.toUpperCase().replace(/[^0-9-]/g, '');
            e.target.value = code;
            
            const statusElement = document.getElementById('input-status');
            if (statusElement) {
                if (code && Utils.validateCode(code)) {
                    e.target.classList.add('valid');
                    e.target.classList.remove('invalid');
                    statusElement.textContent = '✅';
                } else if (code) {
                    e.target.classList.add('invalid');
                    e.target.classList.remove('valid');
                    statusElement.textContent = '❌';
                } else {
                    e.target.classList.remove('valid', 'invalid');
                    statusElement.textContent = '';
                }
            }
        });
    }
});

// Exportar para uso en otros archivos
window.VotingComponents = VotingComponents;
window.AdminComponents = AdminComponents;
window.Utils = Utils;
window.FormValidator = FormValidator;
window.StateManager = StateManager;
// Función global para limpiar estado de modales
window.cleanupModalFunctions = function() {
    const functionsToClean = [
        'changePage', 'filterParticipants', 'saveConjuntoName', 
        'modalResolve', 'powerResolveCallback', 'saveEditedVoting',
        'saveVoterChanges', 'saveVoteEdit'
    ];
    
    functionsToClean.forEach(fn => {
        if (window[fn]) {
            delete window[fn];
        }
    });
};

// Debugging helper
window.debugState = function() {
    console.log('Estado actual:', {
        currentUser: window.currentUser,
        isAdmin: window.isAdmin,
        adminToken: !!window.adminToken,
        voterToken: !!window.voterToken,
        activeModals: !!window.modals?.activeModal,
        intervals: {
            timerInterval: !!window.timerInterval,
            updateInterval: !!window.updateInterval,
            usersRefreshInterval: !!window.usersRefreshInterval
        }
    });
};