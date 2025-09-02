// ================================
// CONFIGURACIÓN Y CONSTANTES
// ================================

const API_BASE = "/api" 
const CODIGO_PRUEBA = '999-999';

// Variables globales de estado (manteniendo la lógica original)
let adminToken = null;
let voterToken = null;
let currentUser = null;
let isAdmin = false;
let adminWebSocket = null;
let voterWebSocket = null;
let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let updateInterval = null;
let lastUpdateTimestamp = 0;
let loadActiveQuestionsTimeout = null;

// ================================
// MANEJO DE ERRORES GLOBALES
// ================================

window.addEventListener('error', (event) => {
    console.error('Error global:', event.error);
    notifications.show('Ha ocurrido un error inesperado. Por favor, recargue la página.', 'error', 10000);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Promise rechazada:', event.reason);
    notifications.show('Error de conectividad. Verifique su conexión a internet.', 'error', 8000);
});

// ================================
// LIMPIAR AL CERRAR VENTANA
// ================================

window.addEventListener('beforeunload', () => {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
});

// Prevenir cierre accidental durante votaciones activas
window.addEventListener('beforeunload', (e) => {
    if (isAdmin || (currentUser && currentUser.code !== CODIGO_PRUEBA)) {
        e.preventDefault();
        e.returnValue = '¿Está seguro de que desea salir? Podría perder datos no guardados.';
    }
});

console.log('🗳️ Sistema de Votación inicializado correctamente');

// ================================
// FUNCIONES GLOBALES PARA MODALES
// ================================
window.processDeleteCode = async function() {
    const code = document.getElementById('delete-code-input').value.trim().toUpperCase();
    
    if (!code || !Utils.validateCode(code)) {
        notifications.show('Formato de código inválido', 'error');
        return;
    }
    
    try {
        await apiCall(`/admin/delete-code/${code}`, { method: 'DELETE' });
        modals.hide();
        await loadAforoData();
        await refreshConnectedUsers(); // Actualizar usuarios conectados
        notifications.show(`Código ${code} eliminado`, 'success');
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
};

window.modalResolvePower = function(isPower) {
    if (window.powerResolveCallback && typeof window.powerResolveCallback === 'function') {
        window.powerResolveCallback(isPower);
    }
};

// ================================
// GESTIÓN DE TOKENS (LÓGICA ORIGINAL)
// ================================

function saveToken(type, token) {
    localStorage.setItem(`${type}_token`, token);
}

function getToken(type) {
    return localStorage.getItem(`${type}_token`);
}

function clearTokens() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('voter_token');
}

// ================================
// COMUNICACIÓN CON API (OPTIMIZADA)
// ================================

async function apiCall(endpoint, options = {}) {
    const token = isAdmin ? adminToken : voterToken;
    
    const config = {
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        },
        ...options
    };

    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }

    try {
        const response = await fetch(`${API_BASE}${endpoint}`, config);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        } else {
            return response;
        }
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// ================================
// WEBSOCKET MANAGEMENT
// ================================

function connectWebSocket() {
    if (isAdmin && !adminWebSocket) {
        connectAdminWebSocket();
    } else if (currentUser && currentUser.code && !voterWebSocket) {
        connectVoterWebSocket(currentUser.code);
    }
}

function connectAdminWebSocket() {
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/admin`;
        
        adminWebSocket = new WebSocket(wsUrl);
        
        adminWebSocket.onopen = () => {
            console.log('Admin WebSocket conectado');
            wsReconnectAttempts = 0;
        };
        
        adminWebSocket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleAdminWebSocketMessage(message);
            } catch (error) {
                console.error('Error procesando mensaje admin:', error);
            }
        };
        
        adminWebSocket.onclose = () => {
            console.log('Admin WebSocket desconectado');
            adminWebSocket = null;
            attemptWebSocketReconnect('admin');
        };
        
        adminWebSocket.onerror = (error) => {
            console.error('Error en Admin WebSocket:', error);
        };
        
    } catch (error) {
        console.error('Error conectando Admin WebSocket:', error);
    }
}

function connectVoterWebSocket(voterCode) {
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/voter/${voterCode}`;
        
        voterWebSocket = new WebSocket(wsUrl);
        
        voterWebSocket.onopen = () => {
            console.log('Voter WebSocket conectado');
            wsReconnectAttempts = 0;
        };
        
        voterWebSocket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleVoterWebSocketMessage(message);
            } catch (error) {
                console.error('Error procesando mensaje voter:', error);
            }
        };
        
        voterWebSocket.onclose = () => {
            console.log('Voter WebSocket desconectado');
            voterWebSocket = null;
            attemptWebSocketReconnect('voter');
        };
        
        voterWebSocket.onerror = (error) => {
            console.error('Error en Voter WebSocket:', error);
        };
        
    } catch (error) {
        console.error('Error conectando Voter WebSocket:', error);
    }
}

function handleAdminWebSocketMessage(message) {
    console.log('Admin WebSocket mensaje:', message.type);
    
    switch (message.type) {
        case 'attendance_registered':
            setTimeout(() => loadAforoData(), 500);
            addActivityLog(`Nueva asistencia: ${message.data.code} - ${message.data.name}`, 'success');
            break;

        case 'vote_registered':
            // Actualizar conteos generales
            setTimeout(() => {
                loadAforoData();
                updateVoteCountsForActiveQuestions();
            }, 300);
            
            // Si hay modal de resultados abierto, actualizarlo
            if (window.currentResultsModal) {
                updateLiveResults(window.currentResultsModal);
            }
            
            addActivityLog(`Voto registrado: ${message.data.participant_code}`, 'info');
            break;

        case 'question_created':
            // Solo recargar si estamos viendo la tab de votaciones
            const activeTab = document.querySelector('.tab-button.active');
            if (activeTab && activeTab.getAttribute('data-tab') === 'votaciones') {
                setTimeout(() => loadActiveQuestions(), 800);
            }
            addActivityLog('Nueva votación creada', 'success');
            break;

        case 'participant_removed':
            setTimeout(() => loadAforoData(), 500);
            notifications.show(`Código eliminado: ${message.data.code}`, 'warning', 4000);
            addActivityLog(`Código eliminado: ${message.data.code}`, 'warning');
            break;

        case 'question_expired':
            // Evitar notificaciones duplicadas
            const lastExpiredKey = `expired_${message.data.question_id}`;
            const now = Date.now();
            if (!window.lastNotifications) window.lastNotifications = {};
            
            if (!window.lastNotifications[lastExpiredKey] || 
                now - window.lastNotifications[lastExpiredKey] > 5000) {
                
                window.lastNotifications[lastExpiredKey] = now;
                setTimeout(() => loadActiveQuestions(), 500);
                addActivityLog(`Votación expirada: ${message.data.text}`, 'warning');
                notifications.show('Una votación ha expirado automáticamente', 'warning');
            }
            break;

        default:
            // Solo log para mensajes no críticos
            console.log('Mensaje WebSocket:', message.type);
    }
}

function handleVoterWebSocketMessage(message) {
    switch (message.type) {
        case 'new_question':
            loadVotingQuestions();
            notifications.show(`📋 Nueva votación: ${message.data.text}`, 'info', 8000);
            break;
        case 'question_status_changed':
            loadVotingQuestions();
            const status = message.data.closed ? 'cerrada' : 'abierta';
            notifications.show(`📊 Votación ${status}: ${message.data.text}`, 'info', 6000);
            break;
        case 'question_deleted':
            loadVotingQuestions();
            notifications.show(`🗑️ Votación eliminada: ${message.data.text}`, 'warning', 6000);
            break;
        case 'time_extended':
            loadVotingQuestions();
            notifications.show(`⏰ ${message.data.message}`, 'success', 10000);
            break;
        case 'admin_message':
            notifications.show(`📢 ${message.data.text}`, message.data.type, message.data.duration);
            break;
        case 'system_reset':
            notifications.show('🔄 La asamblea ha sido reiniciada', 'warning', 10000);
            setTimeout(() => window.location.reload(), 3000);
            break;
        case 'force_disconnect':
            notifications.show(message.data.message, 'error', 10000);
            setTimeout(() => logout(), 2000);
            break;
    }
}

function attemptWebSocketReconnect(type) {
    if (wsReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        wsReconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
        
        setTimeout(() => {
            console.log(`Reintentando conexión WebSocket ${type} (intento ${wsReconnectAttempts})`);
            if (type === 'admin' && isAdmin) {
                connectAdminWebSocket();
            } else if (type === 'voter' && currentUser) {
                connectVoterWebSocket(currentUser.code);
            }
        }, delay);
    } else {
        notifications.show('Conexión perdida. Recargue la página.', 'warning', 15000);
    }
}

function disconnectWebSocket() {
    if (adminWebSocket) {
        adminWebSocket.close();
        adminWebSocket = null;
    }
    if (voterWebSocket) {
        voterWebSocket.close(); 
        voterWebSocket = null;
    }
    wsReconnectAttempts = 0;
}

// ================================
// NAVEGACIÓN ENTRE PANTALLAS
// ================================

function showScreen(screenId) {
    // Ocultar todas las pantallas
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.add('hidden');
    });
    
    // Mostrar pantalla solicitada
    const screen = document.getElementById(screenId);
    if (screen) {
        screen.classList.remove('hidden');
    }
    
    // Mostrar/ocultar botón de logout
    const logoutBtn = document.getElementById('logout-button');
    if (logoutBtn) {
        logoutBtn.classList.toggle('hidden', screenId === 'welcome-screen');
    }
}

function logout() {
    // Limpiar tokens y variables
    clearTokens();
    disconnectWebSocket();
    adminToken = null;
    voterToken = null;
    currentUser = null;
    isAdmin = false;
    
    // Limpiar intervalos
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    
    stopMonitoring();

    // Limpiar formularios
    const accessCode = document.getElementById('access-code');
    if (accessCode) {
        accessCode.value = '';
        accessCode.classList.remove('valid', 'invalid');
    }
    
    // Limpiar status del input
    const inputStatus = document.getElementById('input-status');
    if (inputStatus) {
        inputStatus.textContent = '';
    }

    showScreen('welcome-screen');
    notifications.show('Sesión cerrada correctamente', 'info');
    stopUsersRefreshInterval();
}

// Funciones globales para modales
window.processDeleteCode = processDeleteCode;
window.closeParticipantsModal = () => {
    delete window.changePage;
    delete window.filterParticipants;
    delete window.closeParticipantsModal;
    modals.hide();
};

// ================================
// FUNCIONES DE ACCESO (LÓGICA ORIGINAL)
// ================================

async function registerAttendance() {
    const code = document.getElementById('access-code').value.trim().toUpperCase();
    
    if (!code || !Utils.validateCode(code)) {
        notifications.show('Formato de código inválido. Use formato Torre-Apto (ej: 1-201)', 'error');
        return;
    }

    if (code === CODIGO_PRUEBA) {
        // Usuario de prueba - solo mostrar info
        modals.show({
            title: '🧪 Registro de Demostración',
            content: `
                <div style="text-align: center; padding: 1rem;">
                    <div style="font-size: 3rem; margin-bottom: 1rem;">🎭</div>
                    <h3 style="color: var(--info-color); margin-bottom: 1rem;">Usuario de Prueba Detectado</h3>
                    
                    <div style="background: var(--gray-50); padding: 1.5rem; border-radius: 12px; margin: 1rem 0;">
                        <p><strong>Código:</strong> ${code}</p>
                        <p><strong>Nombre:</strong> Usuario de Demostración</p>
                        <p><strong>Tipo:</strong> Modo Prueba</p>
                    </div>
                    
                    <p style="color: var(--gray-600); font-size: 0.9rem;">
                        Use "Acceder a Votaciones" para ver el sistema en funcionamiento completo
                    </p>
                </div>
            `,
            actions: [{
                text: 'Entendido',
                class: 'btn-info',
                handler: 'modals.hide()'
            }]
        });
        return;
    }

    try {        
        // Verificar que hay participantes en la base
        const dbCheck = await apiCall('/auth/check-database');
        if (!dbCheck.has_participants) {
            notifications.show('No hay participantes registrados en el sistema. El administrador debe cargar la base de datos primero.', 'error');
            return;
        }
        
        // Verificar si ya está registrado
        const checkResponse = await apiCall(`/participants/check/${code}`);
        if (checkResponse.exists) {
            notifications.show('Este código ya tiene asistencia registrada', 'error');
            return;
        }
        
        // Obtener info del participante para mostrar en modal
        let participantInfo;
        try {
            participantInfo = await apiCall(`/participants/info/${code}`);
        } catch (infoError) {
            // Si no puede obtener info, usar datos básicos
            participantInfo = {
                code: code,
                name: 'Participante',
                coefficient: 1.0
            };
            console.log('No se pudo obtener info detallada, usando datos básicos');
        }
        
        // Mostrar modal de confirmación ANTES de registrar
        showAttendanceConfirmModal(participantInfo);
        
    } catch (error) {
        console.error('Error en registro:', error);
        
        if (error.message.includes('404') || error.message.includes('not found')) {
            notifications.show('Su código no está registrado en el sistema. Consulte con la administración del conjunto.', 'error');
        } else {
            notifications.show(`Error: ${error.message}`, 'error');
        }
    }
}

function showAttendanceConfirmModal(participantInfo) {
    // Eliminar el paso de confirmación - ir directo al registro
    processDirectRegistration(participantInfo);
}

async function processDirectRegistration(participantInfo) {
    try {
        // Preguntar tipo de participación directamente
        const isPower = await showPowerQuestion();
        
        // Hacer el registro
        const response = await apiCall('/auth/register-attendance', {
            method: 'POST',
            body: JSON.stringify({ 
                code: participantInfo.code,
                is_power: isPower
            })
        });

        // Configurar usuario global
        window.currentUser = currentUser = {
            code: response.code,
            name: response.name,
            coefficient: response.coefficient,
            is_power: response.is_power
        };

        // Modal de bienvenida simple (sin auto-close problemático)
        setTimeout(() => {
            modals.show({
                title: '🎉 ¡Bienvenido a la Asamblea!',
                content: `
                    <div style="text-align: center; padding: 1rem;">
                        <div style="font-size: 3rem; margin-bottom: 1rem;">✅</div>
                        <h3 style="color: var(--success-color); margin-bottom: 1rem;">Asistencia Registrada</h3>
                        
                        <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(5, 150, 105, 0.05)); padding: 1.5rem; border-radius: 12px; margin: 1rem 0; border: 1px solid var(--success-color);">
                            <p><strong>Código:</strong> ${response.code}</p>
                            <p><strong>Nombre:</strong> ${response.name}</p>
                            <p><strong>Tipo:</strong> ${response.is_power ? '📋 Con Poder' : '🏠 Propietario'}</p>
                            <p><strong>Coeficiente:</strong> ${response.coefficient}%</p>
                        </div>
                        
                        <div style="background: var(--info-color); background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(37, 99, 235, 0.05)); padding: 1rem; border-radius: 8px; margin-top: 1rem; border: 1px solid var(--info-color);">
                            <p style="margin: 0; color: var(--info-dark); font-weight: 500;">
                                🗳️ Ahora puede usar "Acceder a Votaciones" para participar
                            </p>
                        </div>
                    </div>
                `,
                actions: [{
                    text: 'Entendido',
                    class: 'btn-success',
                    handler: 'modals.hide()'
                }],
                closable: true
            });
        }, 500); // Delay para evitar conflictos con el modal anterior
        
        notifications.show('✅ Asistencia registrada. Use "Acceder a Votaciones" para participar.', 'success');
        
    } catch (error) {
        console.error('Error en registro directo:', error);
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

// Nueva función para acceso directo después del registro
window.directAccessVoting = async function() {
    try {
        if (!currentUser || !currentUser.code) {
            notifications.show('Error: Usuario no configurado', 'error');
            return;
        }

        // Usar los datos del usuario ya registrado para hacer login
        const response = await apiCall('/auth/login/voter', {
            method: 'POST',
            body: JSON.stringify({ code: currentUser.code })
        });

        voterToken = response.access_token;
        saveToken('voter', voterToken);
        isAdmin = false;
        
        console.log('Login directo exitoso para:', currentUser.code);
        
        // Ir a pantalla de votante
        await showVoterScreen();
        
    } catch (error) {
        console.error('Error en acceso directo:', error);
        notifications.show('Error accediendo a votaciones. Use "Acceder a Votaciones" manualmente.', 'error');
    }
};

async function accessVoting() {
    const code = document.getElementById('access-code').value.trim().toUpperCase();
    
    if (!code || !Utils.validateCode(code)) {
        notifications.show('Formato de código inválido. Use formato Torre-Apto (ej: 1-201)', 'error');
        return;
    }

    if (code === CODIGO_PRUEBA) {
        showTestUserAdminLogin();
        return;
    }

    try {
        // Verificar que hay participantes en la base
        const dbCheck = await apiCall('/auth/check-database');
        if (!dbCheck.has_participants) {
            notifications.show('No hay participantes registrados en el sistema. El administrador debe cargar la base de datos primero.', 'error');
            return;
        }
        
        // Intentar hacer login
        const response = await apiCall('/auth/login/voter', {
            method: 'POST',
            body: JSON.stringify({ code: code })
        });

        // Login exitoso - configurar usuario
        voterToken = response.access_token;
        saveToken('voter', voterToken);
        
        currentUser = window.currentUser = {
            code: code,
            name: response.name || 'Usuario',
            coefficient: response.coefficient || 1.00,
            is_power: response.is_power || false
        };
        
        isAdmin = false;
        
        notifications.show(`¡Bienvenido ${response.name}! Accediendo a votaciones...`, 'success');
        await showVoterScreen();
        
    } catch (error) {
        console.error('Error en acceso:', error);

        if (error.message.includes('403') || error.message.includes('asistencia primero')) {
            // Usuario no tiene asistencia registrada
            modals.show({
                title: '📋 Registro Requerido',
                content: `
                    <div style="text-align: center; padding: 1rem;">
                        <div style="font-size: 2.5rem; margin-bottom: 1rem;">🚪</div>
                        <h3 style="margin-bottom: 1rem; color: var(--warning-color);">Debe registrar asistencia primero</h3>
                        <p style="color: var(--gray-600); margin-bottom: 1.5rem;">
                            Para acceder a las votaciones, debe registrar su asistencia a la asamblea usando el botón "Registro de Asistencia".
                        </p>
                        <div style="background: var(--gray-100); padding: 1rem; border-radius: 8px;">
                            <p style="margin: 0; font-size: 0.9rem; color: var(--gray-700);">
                                <strong>Código:</strong> ${code}
                            </p>
                        </div>
                    </div>
                `,
                actions: [
                    {
                        text: 'Registrar Asistencia Ahora',
                        class: 'btn-primary',
                        handler: 'modals.hide(); registerAttendance();'
                    },
                    {
                        text: 'Entendido',
                        class: 'btn-secondary',
                        handler: 'modals.hide()'
                    }
                ]
            });
        } else if (error.message.includes('404') || error.message.includes('not found')) {
            notifications.show('Su código no está en el sistema. Consulte con la administración del conjunto.', 'error');
        } else {
            notifications.show(`Error: ${error.message}`, 'error');
        }
    }
}

function showAdminLogin() {
    modals.show({
        title: '🔐 Acceso Administrador',
        content: `
            <input type="text" id="modal-admin-username" class="modal-input" placeholder="Usuario" />
            <input type="password" id="modal-admin-password" class="modal-input" placeholder="Contraseña" />
        `,
        actions: [
            {
                text: 'Cancelar',
                class: 'btn-secondary',
                handler: 'modals.hide()'
            },
            {
                text: 'Ingresar',
                class: 'btn-primary',
                handler: 'validateAdminCredentials()'
            }
        ]
    });
    
    // AGREGAR DESPUÉS DEL MODAL
    setTimeout(() => {
        const usernameInput = document.getElementById('modal-admin-username');
        const passwordInput = document.getElementById('modal-admin-password');
        
        [usernameInput, passwordInput].forEach(input => {
            if (input) {
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        validateAdminCredentials();
                    }
                });
            }
        });
        
        // Focus en el primer input
        if (usernameInput) usernameInput.focus();
    }, 100);
}
async function validateAdminCredentials() {
    const username = document.getElementById('modal-admin-username').value.trim();
    const password = document.getElementById('modal-admin-password').value.trim();
    
    if (!username || !password) {
        notifications.show('Complete usuario y contraseña', 'error');
        return;
    }

    try {
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', password);

        const response = await apiCall('/auth/login/admin', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData
        });

        adminToken = response.access_token;
        saveToken('admin', adminToken);
        isAdmin = true;
        
        modals.hide();
        await showAdminScreen();
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

// ================================
// MODALES AUXILIARES
// ================================

function showAttendanceModal(userData) {
    modals.show({
        title: '✅ Asistencia Registrada',
        content: `
            <p><strong>Código:</strong> ${userData.code}</p>
            <p><strong>Nombre:</strong> ${userData.name}</p>
            <p><strong>Tipo:</strong> ${userData.is_power ? 'Con Poder' : 'Propietario'}</p>
        `,
        actions: [
            {
                text: 'Cerrar',
                class: 'btn-primary',
                handler: 'modals.hide()'
            }
        ]
    });
}

function showPowerQuestion() {
    return new Promise((resolve) => {
        // Limpiar callback previo si existe
        if (window.powerResolveCallback) {
            try {
                window.powerResolveCallback(false); // Resolver como false
            } catch (e) {
                console.log('Error limpiando callback previo:', e);
            }
            delete window.powerResolveCallback;
        }
        
        // Crear nuevo callback
        window.powerResolveCallback = (isPower) => {
            try {
                const callback = window.powerResolveCallback;
                delete window.powerResolveCallback;
                modals.hide();
                resolve(isPower);
            } catch (e) {
                console.error('Error en powerResolveCallback:', e);
                resolve(false);
            }
        };
        
        modals.show({
            title: '🏠 Información del Apartamento',
            content: `
                <div style="text-align: center; padding: 1rem;">
                    <div style="font-size: 2.5rem; margin-bottom: 1rem;">🤔</div>
                    <h3 style="margin-bottom: 1.5rem; color: var(--dark-color);">¿Cómo va a votar?</h3>
                    <p style="margin-bottom: 2rem; color: var(--gray-600);">
                        Seleccione la opción que corresponde a su situación:
                    </p>
                </div>
                
                <div style="display: grid; gap: 1rem;">
                    <button class="btn btn-success btn-large" onclick="window.modalResolvePower(false)" 
                            style="display: flex; align-items: center; justify-content: center; gap: 1rem; padding: 1.5rem;">
                        <span style="font-size: 1.5rem;">🏠</span>
                        <div>
                            <div style="font-weight: 600;">Soy Propietario</div>
                            <div style="font-size: 0.9rem; opacity: 0.8;">Voto por mi apartamento</div>
                        </div>
                    </button>
                    
                    <button class="btn btn-warning btn-large" onclick="window.modalResolvePower(true)" 
                            style="display: flex; align-items: center; justify-content: center; gap: 1rem; padding: 1.5rem;">
                        <span style="font-size: 1.5rem;">📋</span>
                        <div>
                            <div style="font-weight: 600;">Tengo Poder</div>
                            <div style="font-size: 0.9rem; opacity: 0.8;">Represento a otro propietario</div>
                        </div>
                    </button>
                </div>
            `,
            closable: false
        });
        
        // Auto-cleanup si no responde
        setTimeout(() => {
            if (window.powerResolveCallback === resolve) {
                delete window.powerResolveCallback;
                modals.hide();
                resolve(false); // Default: propietario
                notifications.show('Tiempo agotado. Se seleccionó "Propietario" por defecto.', 'warning', 5000);
            }
        }, 60000);
    });
}

// ================================
// PANTALLA DE VOTANTES
// ================================

async function showVoterScreen() {
    // Limpiar intervalos previos
    if (window.timerInterval) {
        clearInterval(window.timerInterval);
        window.timerInterval = null;
    }
    
    // Asegurar que currentUser esté definido
    if (!currentUser || !currentUser.code) {
        console.error('No hay usuario válido para showVoterScreen');
        notifications.show('Error: Usuario no inicializado', 'error');
        logout();
        return;
    }
    
    console.log('Mostrando pantalla de votante para:', currentUser.code);
    showScreen('voter-screen');
    
    // Solo conectar WebSocket si NO es usuario de prueba
    if (currentUser.code !== CODIGO_PRUEBA) {
        connectWebSocket();
    }
    
    // Actualizar interfaz
    document.getElementById('voter-code').textContent = currentUser.code;
    document.getElementById('voter-name').textContent = `Bienvenido/a, ${currentUser.name}`;
    
    updateVoterInterface();
    
    // Cargar preguntas con timeout de seguridad
    setTimeout(async () => {
        try {
            await loadVotingQuestions();
        } catch (error) {
            console.error('Error cargando votaciones:', error);
            notifications.show('Error cargando votaciones. Reintentando...', 'warning');
            setTimeout(() => loadVotingQuestions(), 2000);
        }
    }, 100);
}

function updateVoterInterface() {
    const userMeta = document.querySelector('.user-meta');
    if (!userMeta) return;
    
    // Limpiar elementos previos
    const oldElements = userMeta.querySelectorAll('#voter-coefficient, #voter-conjunto');
    oldElements.forEach(el => el.remove());
    
    // Agregar coeficiente
    if (currentUser.coefficient) {
        const coeffElement = document.createElement('span');
        coeffElement.id = 'voter-coefficient';
        coeffElement.textContent = `Coeficiente: ${parseFloat(currentUser.coefficient || 0).toFixed(2)}%`;
        userMeta.appendChild(coeffElement);
    }
    
    // Agregar nombre del conjunto o info de demo
    loadConjuntoName();
}

async function loadConjuntoName() {
    try {
        const userMeta = document.querySelector('.user-meta');
        if (!userMeta) return;
        
        let conjuntoElement = document.getElementById('voter-conjunto');
        if (!conjuntoElement) {
            conjuntoElement = document.createElement('span');
            conjuntoElement.id = 'voter-conjunto';
            userMeta.appendChild(conjuntoElement);
        }
        
        if (currentUser.code === CODIGO_PRUEBA) {
            conjuntoElement.textContent = '🧪 MODO DEMOSTRACIÓN';
        } else {
            try {
                const conjuntoData = await apiCall('/participants/conjunto/nombre/public');
                conjuntoElement.textContent = conjuntoData?.nombre || 'Conjunto Residencial';
            } catch (error) {
                conjuntoElement.textContent = 'Conjunto Residencial';
            }
        }
    } catch (error) {
        console.log('No se pudo cargar nombre del conjunto');
    }
}

async function loadVotingQuestions() {
    const container = document.getElementById('voting-questions');
    if (!container) {
        console.error('Container voting-questions no encontrado');
        return;
    }
    
    try {
        console.log('Cargando votaciones para usuario:', currentUser?.code);
        
        if (currentUser && currentUser.code === CODIGO_PRUEBA) {
            const testQuestions = loadDemoVotingQuestions();
            renderVotingQuestions(testQuestions);
            return;
        }

        if (!voterToken) {
            container.innerHTML = `<div class="panel"><p style="color: var(--danger-color); text-align: center;">Sesión expirada. Por favor, ingrese nuevamente.</p></div>`;
            return;
        }

        // Cargar preguntas y votos del usuario
        const [questions, userVotes] = await Promise.all([
            apiCall('/voting/questions/active'),
            apiCall('/voting/my-votes').catch(() => []) // Si falla, array vacío
        ]);
        
        const votedQuestions = new Set(userVotes.map(vote => vote.question_id));
        
        console.log('Preguntas cargadas:', questions.length);
        renderVotingQuestions(questions, votedQuestions);

    } catch (error) {
        console.error('Error cargando votaciones:', error);
        container.innerHTML = `
            <div class="panel">
                <p style="color: var(--danger-color); text-align: center;">
                    Error cargando votaciones: ${error.message}
                </p>
                <button class="btn btn-primary" onclick="loadVotingQuestions()" style="margin-top: 1rem;">
                    🔄 Reintentar
                </button>
            </div>
        `;
    }
}

function updateVotingTimers() {
    document.querySelectorAll('.question-timer').forEach(timer => {
        const remaining = parseInt(timer.getAttribute('data-remaining'));
        if (remaining > 0) {
            const newRemaining = remaining - 1;
            timer.setAttribute('data-remaining', newRemaining);
            const minutes = Math.floor(newRemaining / 60);
            const seconds = newRemaining % 60;
            timer.textContent = `⏰ ${minutes}:${String(seconds).padStart(2, '0')} restantes`;
            
            if (newRemaining < 120) {
                timer.style.background = 'linear-gradient(135deg, var(--danger-color), var(--danger-dark))';
                timer.style.animation = 'pulse 2s infinite';
            }
        } else {
            timer.textContent = '⏰ Tiempo agotado';
            timer.style.background = 'linear-gradient(135deg, var(--danger-color), var(--danger-dark))';
        }
    });
}

function renderVotingQuestions(questions, votedQuestions = new Set()) {
    const container = document.getElementById('voting-questions');
    
    if (questions.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
                    <path d="M9 7V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path>
                </svg>
                <h3>No hay votaciones activas</h3>
                <p>Espere a que el administrador active nuevas votaciones para poder participar</p>
            </div>
        `;
        return;
    }

    console.log('Renderizando', questions.length, 'preguntas');
    
    const availableQuestions = questions.filter(q => !q.closed && !q.is_expired);

    if (availableQuestions.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
                    <path d="M9 7V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path>
                </svg>
                <h3>No hay votaciones disponibles</h3>
                <p>Todas las votaciones han terminado o están cerradas</p>
            </div>
        `;
        return;
    }

    const questionsHTML = availableQuestions.map(question => {
        const userVoted = votedQuestions.has(question.id);
        console.log('Procesando pregunta:', question.id, 'votado:', userVoted);
        
        if (userVoted) {
            return VotingComponents.createVotedStatus(question, 'Ya votaste');
        } else if (question.closed) {
            return `
                <div class="voting-card">
                    <div class="question-header">
                        <div class="question-title">${question.text}</div>
                        <div class="question-status closed">🔒 CERRADA</div>
                    </div>
                    <div class="voted-status">
                        🔒 Esta votación ha sido cerrada
                    </div>
                </div>
            `;
        } else {
            if (question.type === 'yesno') {
                return VotingComponents.createYesNoVoting(question);
            } else {
                return VotingComponents.createMultipleVoting(question);
            }
        }
    }).join('');

    container.innerHTML = questionsHTML;
    
    // Inicializar timers si hay preguntas con tiempo
    const hasTimedQuestions = questions.some(q => q.time_remaining_seconds > 0);
    if (hasTimedQuestions) {
        setTimeout(initializeVotingTimer, 100);
    }
}

function initializeVotingTimer() {
    if (window.timerInterval) {
        clearInterval(window.timerInterval);
    }
    
    const timers = document.querySelectorAll('.question-timer[data-remaining]');
    if (timers.length > 0) {
        window.timerInterval = setInterval(() => {
            let activeTimers = 0;
            
            timers.forEach(timer => {
                const remaining = parseInt(timer.getAttribute('data-remaining'));
                if (remaining > 0) {
                    activeTimers++;
                    const newRemaining = remaining - 1;
                    timer.setAttribute('data-remaining', newRemaining);
                    
                    const minutes = Math.floor(newRemaining / 60);
                    const seconds = newRemaining % 60;
                    timer.textContent = `⏰ ${minutes}:${String(seconds).padStart(2, '0')} restantes`;
                    
                    if (newRemaining < 60) {
                        timer.style.color = 'var(--danger-color)';
                        timer.style.fontWeight = '700';
                    }
                } else if (remaining === 0) {
                    timer.textContent = '⏰ Tiempo agotado';
                    timer.style.background = 'linear-gradient(135deg, var(--danger-color), var(--danger-dark))';
                    timer.style.animation = 'pulse 2s infinite';
                    
                    // Recargar preguntas cuando expire
                    setTimeout(() => {
                        if (typeof loadVotingQuestions === 'function') loadVotingQuestions();
                        if (typeof loadActiveQuestions === 'function') loadActiveQuestions();
                    }, 2000);
                }
            });
            
            if (activeTimers === 0) {
                clearInterval(window.timerInterval);
                window.timerInterval = null;
            }
        }, 1000);
    }
}

async function checkUserVotes() {
    try {
        if (currentUser && currentUser.code === CODIGO_PRUEBA) {
            return new Set(); // Usuario de prueba no tiene votos registrados
        }
        
        const userVotes = await apiCall('/voting/my-votes');
        return new Set(userVotes.map(vote => vote.question_id));
    } catch (error) {
        console.error('Error al comprobar los votos del usuario:', error);
        return new Set();
    }
}

// ================================
// FUNCIONES DE VOTACIÓN
// ================================

async function voteYesNo(questionId, answer) {
    try {
        await apiCall('/voting/vote', {
            method: 'POST',
            body: JSON.stringify({
                question_id: questionId,
                answer: answer
            })
        });
        
        notifications.show('Voto registrado correctamente', 'success');
        await loadVotingQuestions(); // Recargar para mostrar estado actualizado
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function deleteVoting(questionId) {
    try {        
        const confirmed = await modals.confirm(
            '¿Eliminar esta votación?\n\nSe borrarán también todos los votos registrados.',
            'Confirmar eliminación'
        );
                
        if (!confirmed) {
            console.log('Eliminación cancelada');
            return;
        }
        
        try {
            await apiCall(`/voting/questions/${questionId}`, { method: 'DELETE' });
            await loadActiveQuestions();
            notifications.show('Votación eliminada correctamente', 'success');
        } catch (error) {
            console.error('Error eliminando votación:', error);
            notifications.show(`Error al eliminar: ${error.message}`, 'error');
        }
        
    } catch (error) {
        console.error('Error con modal de confirmación:', error);
        notifications.show('Error en la confirmación', 'error');
    }
}

function selectMultipleOption(element, questionId, maxSelections, allowMultiple) {
    const container = element.closest('.voting-card');
    const selectedOptions = container.querySelectorAll('.multiple-option.selected');
    const submitBtn = container.querySelector('.submit-btn');
    
    if (allowMultiple) {
        // Selección múltiple
        if (!element.classList.contains('selected') && selectedOptions.length >= maxSelections) {
            notifications.show(`Solo puede seleccionar máximo ${maxSelections} opciones`, 'error');
            return;
        }
        
        element.classList.toggle('selected');
        
        // Limpiar todos los indicators
        container.querySelectorAll('.option-indicator').forEach(indicator => {
            indicator.textContent = '';
        });
        
        // Actualizar contadores
        const nowSelected = container.querySelectorAll('.multiple-option.selected'); // <- AGREGAR ESTA LÍNEA
        const countDisplay = container.querySelector('.selected-count');
        if (countDisplay) {
            countDisplay.textContent = nowSelected.length;
        }
        
        // Actualizar botón
        if (nowSelected.length > 0) {
            submitBtn.disabled = false;
            submitBtn.textContent = `Confirmar ${nowSelected.length} Selección${nowSelected.length > 1 ? 'es' : ''}`;
        } else {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Confirmar Selección';
        }
    } else {
        // Selección única - desmarcar otros
        selectedOptions.forEach(option => {
            option.classList.remove('selected');
            option.querySelector('.option-indicator').textContent = '';
        });
        
        // Marcar el seleccionado
        element.classList.add('selected');
        element.querySelector('.option-indicator').textContent = '';
        
        // Habilitar botón
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirmar Selección';
    }
}

async function submitMultipleVote(questionId) {
    const container = document.querySelector(`[data-question-id="${questionId}"]`);
    const selectedOptions = container.querySelectorAll('.multiple-option.selected');
    
    if (selectedOptions.length === 0) {
        notifications.show('Debe seleccionar al menos una opción', 'error');
        return;
    }
    
    const answers = Array.from(selectedOptions).map(option => 
        option.getAttribute('data-option') || option.querySelector('.option-text').textContent
    );
    
    if (currentUser && currentUser.code === CODIGO_PRUEBA) {
        // Obtener respuestas seleccionadas correctamente
        const container = document.querySelector(`[data-question-id="${questionId}"]`);
        const selectedOptions = container.querySelectorAll('.multiple-option.selected');
        const answers = Array.from(selectedOptions).map(option => 
            option.getAttribute('data-option') || option.querySelector('.option-text').textContent
        );
        
        const answerText = answers.length === 1 ? answers[0] : answers.join(', ');
        notifications.show(`Votos demo registrados: ${answerText}`, 'success');
        
        // Simular que ya votó - mostrar estado votado
        setTimeout(() => {
            const votingCard = container.closest('.voting-card');
            if (votingCard) {
                votingCard.innerHTML = VotingComponents.createVotedStatus({
                    id: questionId,
                    text: votingCard.querySelector('.question-title').textContent
                }, answerText);
            }
        }, 1000);
        return;
    }

    try {
        await apiCall('/voting/vote', {
            method: 'POST',
            body: JSON.stringify({
                question_id: questionId,
                answer: answers
            })
        });

        await loadVotingQuestions();
        notifications.show(`Votos registrados: ${answers.join(', ')}`, 'success');
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

// ================================
// PANTALLA DE ADMINISTRADOR
// ================================

async function showAdminScreen() {
    showScreen('admin-screen');
    connectWebSocket();
    document.getElementById('create-voting-form').innerHTML = AdminComponents.createVotingForm();
    setupAdminEventListeners();
    showAdminTab('estado');
    await loadAdminData();
    
    // Solo actualizar display si ya existe el nombre
    try {
        const response = await apiCall('/participants/conjunto/nombre');
        if (response.nombre) {
            updateConjuntoDisplay(response.nombre);
            const estadoDisplay = document.getElementById('conjunto-display-estado');
            if (estadoDisplay) {
                estadoDisplay.textContent = response.nombre;
            }
        } else {
            // Si no hay nombre configurado
            const estadoDisplay = document.getElementById('conjunto-display-estado');
            if (estadoDisplay) {
                estadoDisplay.textContent = 'Configurar Nombre del Conjunto';
            }
        }
    } catch (error) {
        console.log('No se pudo cargar nombre del conjunto');
        const estadoDisplay = document.getElementById('conjunto-display-estado');
        if (estadoDisplay) {
            estadoDisplay.textContent = 'Configurar Nombre del Conjunto';
        }
    }
    startMonitoring();
}

function showConjuntoModal() {
    return new Promise((resolve) => {
        modals.show({
            title: 'Configurar Conjunto',
            content: `
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">
                    Nombre del Conjunto Residencial:
                </label>
                <input type="text" id="conjunto-name-input" class="modal-input" 
                       placeholder="Ej: Conjunto Torres del Parque">
            `,
            actions: [
                {
                    text: 'Guardar',
                    class: 'btn-success',
                    handler: 'saveConjuntoName()'
                }
            ],
            closable: false
        });
        
        window.saveConjuntoName = async () => {
            const nombre = document.getElementById('conjunto-name-input').value.trim();
            if (!nombre) {
                notifications.show('Por favor ingrese el nombre del conjunto', 'error');
                return;
            }
            
            try {
                await apiCall('/participants/conjunto/nombre', {
                    method: 'POST',
                    body: JSON.stringify({ nombre: nombre })
                });
                
                const estadoDisplay = document.getElementById('conjunto-display-estado');
                if (estadoDisplay) {
                    estadoDisplay.textContent = nombre;
                }
                updateConjuntoDisplay(nombre);
                modals.hide();
                delete window.saveConjuntoName;
                notifications.show('Nombre del conjunto guardado', 'success');
                resolve(true);
            } catch (error) {
                notifications.show(`Error: ${error.message}`, 'error');
            }
        };
        window.processDeleteCode = processDeleteCode;
    });
}

function updateConjuntoDisplay(nombre) {
    const displays = [
        document.getElementById('conjunto-name-display'),
        document.getElementById('conjunto-name-small')
    ];
    
    displays.forEach(display => {
        if (display) {
            display.textContent = nombre;
        }
    });
}

function setupAdminEventListeners() {
    // Tabs de administrador
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const tabName = e.target.getAttribute('data-tab');
            showAdminTab(tabName);
        });
    });
    
    // Verificar participantes
    document.getElementById('check-participants-btn').addEventListener('click', checkParticipants);
    
    // Upload de archivo
    const fileUpload = document.getElementById('file-upload-area');
    const fileInput = document.getElementById('excel-file');
    
    fileUpload.addEventListener('click', () => fileInput.click());
    fileUpload.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileUpload.classList.add('dragover');
    });
    fileUpload.addEventListener('dragleave', () => {
        fileUpload.classList.remove('dragover');
    });
    fileUpload.addEventListener('drop', (e) => {
        e.preventDefault();
        fileUpload.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            fileInput.files = files;
            uploadExcel();
        }
    });
    
    fileInput.addEventListener('change', uploadExcel);
    
    // Botones de configuración
    document.getElementById('delete-code-btn').addEventListener('click', showDeleteCodeModal);
    document.getElementById('download-reports-btn').addEventListener('click', downloadReports);
    document.getElementById('reset-database-btn').addEventListener('click', resetDatabase);
    
    // Formulario de votación
    setupVotingFormListeners();
}

function setupVotingFormListeners() {
    // Selector de tipo
    document.querySelectorAll('.type-option').forEach(option => {
        option.addEventListener('click', (e) => {
            const type = e.currentTarget.getAttribute('data-type');
            selectVotingType(type);
        });
    });
    
    // Toggle de selección múltiple
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const mode = e.target.getAttribute('data-mode');
            setSelectionMode(mode);
        });
    });

    // Timer toggle buttons - configuración inicial
    document.querySelectorAll('.timer-toggle-btn').forEach(btn => {
        const enabled = btn.getAttribute('data-enabled') === 'true';
        
        // Estado inicial correcto
        btn.classList.remove('active');
        if (!enabled) {
            btn.classList.add('active');
            btn.style.background = 'var(--danger-color)';  // CAMBIAR AQUÍ
            btn.style.borderColor = 'var(--danger-color)';  // Y AQUÍ
            btn.style.color = 'white';
        } else {
            btn.style.background = 'white';
            btn.style.borderColor = 'var(--gray-300)';
            btn.style.color = 'var(--gray-600)';
        }

        // Event listener
        btn.addEventListener('click', (e) => {
            const clickedEnabled = e.target.getAttribute('data-enabled') === 'true';
            
            // Resetear todos los botones
            document.querySelectorAll('.timer-toggle-btn').forEach(b => {
                b.classList.remove('active');
                b.style.background = 'white';
                b.style.borderColor = 'var(--gray-300)';
                b.style.color = 'var(--gray-600)';
            });
            
            // Activar el clickeado
            e.target.classList.add('active');
            if (clickedEnabled) {
                e.target.style.background = 'var(--success-color)';
                e.target.style.borderColor = 'var(--success-color)';
                e.target.style.color = 'white';
            } else {
                e.target.style.background = 'var(--danger-color)';  // CAMBIAR AQUÍ TAMBIÉN
                e.target.style.borderColor = 'var(--danger-color)';  // Y AQUÍ
                e.target.style.color = 'white';
            }
            
            // Mostrar/ocultar input de minutos
            const minutesContainer = document.getElementById('timer-minutes-container');
            if (minutesContainer) {
                if (clickedEnabled) {
                    minutesContainer.style.opacity = '1';
                    minutesContainer.style.pointerEvents = 'auto';
                } else {
                    minutesContainer.style.opacity = '0.5';
                    minutesContainer.style.pointerEvents = 'none';
                }
            }
        });
    });

    // Estado inicial del contenedor de minutos
    const minutesContainer = document.getElementById('timer-minutes-container');
    if (minutesContainer) {
        minutesContainer.style.opacity = '0.5';
        minutesContainer.style.pointerEvents = 'none';
    }
}

function showAdminTab(tabName) {
    // Ocultar todas las pestañas
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Mostrar la pestaña seleccionada
    const targetTab = document.getElementById(`tab-${tabName}`);
    const targetButton = document.querySelector(`[data-tab="${tabName}"]`);
    
    if (targetTab && targetButton) {
        targetTab.classList.add('active');
        targetButton.classList.add('active');
        
        // Solo cargar datos cuando se activa la tab de votaciones
        if (tabName === 'votaciones') {
            console.log('Cargando tab de votaciones...');
            setTimeout(() => loadActiveQuestions(), 100);
        } else if (tabName === 'estado') {
            setTimeout(() => loadAforoData(), 100);
        } else if (tabName === 'configuracion') {
            setTimeout(() => refreshConnectedUsers(), 100);
        } else if (tabName === 'monitoreo') {
            setTimeout(() => refreshServerStatus(), 100);
        }
    }
}

async function loadAdminData() {
    console.log('Iniciando carga de datos admin...');
    await Promise.all([
        loadAforoData(),
        refreshConnectedUsers(),
        loadParticipantsStatus()
    ]);
    
    await loadActiveQuestions();
    startUsersRefreshInterval();
}

async function loadParticipantsStatus() {
    try {
        const response = await apiCall('/participants/');
        const statusCircle = document.getElementById('status-circle');
        const statusText = document.getElementById('status-text');
        
        if (response.length === 0) {
            statusCircle.className = 'status-circle error';
            statusText.textContent = 'Sin participantes registrados';
        } else {
            statusCircle.className = 'status-circle success';
            statusText.textContent = `${response.length} participantes registrados`;
        }
    } catch (error) {
        const statusCircle = document.getElementById('status-circle');
        const statusText = document.getElementById('status-text');
        statusCircle.className = 'status-circle error';
        statusText.textContent = 'Error al verificar';
    }
}

async function loadAforoData() {
    try {
        const data = await apiCall('/voting/aforo');
        
        // Actualizar contadores básicos
        document.getElementById('total-participants').textContent = data.total_participants || 0;
        document.getElementById('present-count').textContent = data.present_count || 0;
        document.getElementById('own-votes-count').textContent = data.own_votes || 0;
        document.getElementById('power-votes-count').textContent = data.power_votes || 0;
        
        // Actualizar porcentaje del coeficiente
        const coefficientPercentage = data.coefficient_rate_percent || 0;
        document.getElementById('coefficient-percentage').textContent = `${coefficientPercentage.toFixed(2)}%`;

        // Actualizar estado del quórum
        const quorumRequired = 51;
        const quorumMet = coefficientPercentage >= quorumRequired;
        
        const coefficientPanel = document.getElementById('coefficient-panel');
        const quorumIndicator = document.getElementById('quorum-indicator');
        const quorumText = document.getElementById('quorum-text');
        
        if (quorumMet) {
            coefficientPanel.classList.remove('no-quorum');
            quorumIndicator.textContent = '✅';
            quorumText.textContent = 'QUÓRUM ALCANZADO';
            quorumText.className = 'quorum-text success';
        } else {
            coefficientPanel.classList.add('no-quorum');
            quorumIndicator.textContent = '❌';
            quorumText.textContent = 'SIN QUÓRUM';
            quorumText.className = 'quorum-text error';
        }

        // Animar números
        Utils.animateNumber(document.getElementById('total-participants'), 0, data.total_participants || 0);
        Utils.animateNumber(document.getElementById('present-count'), 0, data.present_count || 0);
        
    } catch (error) {
        console.error('Error loading aforo:', error);
        // Mostrar valores de error
        ['total-participants', 'present-count', 'own-votes-count', 'power-votes-count'].forEach(id => {
            document.getElementById(id).textContent = 'Error';
        });
        document.getElementById('coefficient-percentage').textContent = 'Error';
    }
}

async function loadActiveQuestions() {
    // Evitar llamadas múltiples
    if (loadActiveQuestionsTimeout) {
        clearTimeout(loadActiveQuestionsTimeout);
    }
    
    loadActiveQuestionsTimeout = setTimeout(async () => {
        try {
            const questions = await apiCall('/voting/questions/active');
            renderActiveQuestions(questions);
            await updateVoteCountsForActiveQuestions();
            startAdminTimers();
        } catch (error) {
            console.error('Error loading active questions:', error);
            const container = document.getElementById('active-questions');
            if (container) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 2rem; color: var(--danger-color);">
                        <p>Error al cargar las votaciones</p>
                        <button onclick="loadActiveQuestions()" class="btn btn-primary" style="margin-top: 1rem;">
                            Reintentar
                        </button>
                    </div>
                `;
            }
        }
    }, 100);
}

function startAdminTimers() {

    if (window.adminTimerInterval) {
        clearInterval(window.adminTimerInterval);
    }

    window.adminTimerInterval = setInterval(async () => {
        try {
            const questions = await apiCall('/voting/questions/active');
            
            document.querySelectorAll('.countdown-timer').forEach(timer => {
                const questionId = parseInt(timer.getAttribute('data-question-id'));
                const question = questions.find(q => q.id === questionId);
                
                if (question && question.time_remaining_seconds !== null) {
                    if (question.time_remaining_seconds <= 0) {
                        timer.textContent = '(Tiempo agotado)';
                        timer.style.color = 'var(--danger-color)';
                    } else {
                        const minutes = Math.floor(question.time_remaining_seconds / 60);
                        const seconds = question.time_remaining_seconds % 60;
                        timer.textContent = `(${minutes}:${String(seconds).padStart(2, '0')} restantes)`;
                        timer.style.color = question.time_remaining_seconds < 120 ? 'var(--danger-color)' : 'var(--warning-color)';
                    }
                }
            });

            await manager.broadcast_to_voters({
                "type": "questions_updated"
            });
            
        } catch (error) {
            console.error('Error actualizando timers admin:', error);
        }
    }, 1000);
}

async function refreshConnectedUsers() {
    try {
        const users = await apiCall('/admin/connected-users');
        renderConnectedUsers(users);
    } catch (error) {
        console.error('Error loading connected users:', error);
        document.getElementById('connected-users-display').innerHTML = 
            '<p style="color: var(--danger-color);">Error cargando usuarios conectados</p>';
    }
}

function renderConnectedUsers(data) {
    const container = document.getElementById('connected-users-display');
    
    const adminCount = data.admin_connections || 0;
    const voterCount = data.voter_connections || 0;
    const connectedVoters = data.connected_voters || [];
    
    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
            <div class="stat-card">
                <div class="stat-number">${adminCount}</div>
                <div class="stat-label">Admins</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${voterCount}</div>
                <div class="stat-label">Votantes</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${data.total_connected || 0}</div>
                <div class="stat-label">Total</div>
            </div>
        </div>
        
        ${connectedVoters.length > 0 ? `
            <div style="max-height: 200px; overflow-y: auto; border: 1px solid var(--gray-300); border-radius: 12px;">
                <div style="background: var(--gray-100); padding: 0.8rem; font-weight: 600; border-bottom: 1px solid var(--gray-300);">
                    Votantes Conectados
                </div>
                ${connectedVoters.map(voter => `
                    <div style="padding: 0.8rem; border-bottom: 1px solid var(--gray-200); display: grid; grid-template-columns: auto 1fr auto auto; gap: 1rem; align-items: center;">
                        <strong style="color: var(--dark-color);">${voter.code}</strong>
                        <span style="overflow: hidden; text-overflow: ellipsis;">${voter.name}</span>
                        <span style="color: var(--primary-color); font-weight: 600;">${voter.coefficient.toFixed(2)}%</span>
                        <span style="background: ${voter.is_power ? 'var(--warning-color)' : 'var(--success-color)'}; color: white; padding: 0.3rem 0.8rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600;">
                            ${voter.is_power ? 'Poder' : 'Propio'}
                        </span>
                    </div>
                `).join('')}
            </div>
        ` : '<p style="text-align: center; color: var(--gray-600); padding: 2rem;">No hay votantes conectados</p>'}
    `;
}

function renderActiveQuestions(questions) {
    const container = document.getElementById('active-questions');
    
    if (questions.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
                    <path d="M9 7V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path>
                </svg>
                <h3>No hay votaciones creadas</h3>
                <p>Cree una nueva votación usando el formulario de arriba para comenzar el proceso de votación</p>
            </div>
        `;
        return;
    }

    const questionsHTML = questions.map(q => {
        
        const typeText = q.type === 'yesno' ? 'Sí/No' : 
                        (q.allow_multiple ? 'Selección múltiple' : 'Selección única');
        
        // Asegurar que las opciones existan
        const options = q.options || [];
        
        return `
            <div class="voting-card admin-card" data-question-id="${q.id}">
                <div class="voting-header">
                    <div class="voting-title">${q.text || 'Sin título'}</div>
                    <div class="voting-status ${q.closed ? 'closed' : 'open'}">
                        ${q.closed ? '🔒 Cerrada' : '🟢 Abierta'}
                    </div>
                </div>
                
                <div class="voting-meta">
                    <div class="meta-item">
                        <span>📊</span>
                        <span>Tipo: ${typeText}</span>
                    </div>
                    <div class="meta-item">
                        <span>🗳️</span>
                        <span>Votos: <span class="vote-count" data-question-id="${q.id}">0</span></span>
                    </div>
                    <div class="meta-item">
                        <span>⏱️</span>
                        <span>Estado: ${q.closed ? 'Finalizada' : 'En progreso'}</span>
                    </div>
                    ${q.time_limit_minutes ? `
                        <div class="meta-item">
                            <span>⏰</span>
                            <span>Límite: ${q.time_limit_minutes} min
                                ${q.expires_at && q.time_remaining_seconds !== null ?
                                    `<span class="countdown-timer" data-question-id="${q.id}" style="color: ${q.time_remaining_seconds > 0 ? 'var(--warning-color)' : 'var(--danger-color)'}; font-weight: 600; margin-left: 8px;">
                                        ${q.time_remaining_seconds > 0 ? 
                                            '(' + Math.floor(q.time_remaining_seconds/60) + ':' + String(q.time_remaining_seconds%60).padStart(2,'0') + ' restantes)' 
                                            : '(Tiempo agotado)'}
                                    </span>`
                                    : ''
                                }
                            </span>
                        </div>
                    ` : ''}
                </div>

                <div class="voting-options-preview">
                    <h4>Opciones:</h4>
                    <div class="options-tags">
                        ${options.map(opt => 
                            `<span class="option-tag">${opt.text}</span>`
                        ).join('')}
                    </div>
                </div>

                <div class="voting-actions">
                    <button class="btn ${q.closed ? 'btn-success' : 'btn-warning'}" 
                            onclick="toggleVotingStatus(${q.id})">
                        ${q.closed ? '▶️ Abrir' : '⏸️ Cerrar'}
                    </button>
                    
                    <button class="btn btn-info" onclick="viewVotingResults(${q.id})">
                        📊 Ver Resultados
                    </button>

                    ${q.time_limit_minutes ? `
                        <button class="btn btn-warning" onclick="showExtendTimeModal(${q.id}, '${q.text}')">
                            ⏰ Extender Tiempo
                        </button>
                    ` : ''}
                    
                    ${q.closed ? `
                        <button class="btn btn-secondary" onclick="editVoting(${q.id})">
                            ✏️ Editar
                        </button>
                    ` : ''}
                    
                    <button class="btn btn-danger" onclick="deleteVoting(${q.id})">
                        🗑️ Eliminar
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = questionsHTML;
}

async function updateVoteCountsForActiveQuestions() {
    try {
        const questions = await apiCall('/voting/questions/active');
        for (const question of questions) {
            try {
                const results = await apiCall(`/voting/results/${question.id}`);                
                const voteCountElement = document.querySelector(`.vote-count[data-question-id="${question.id}"]`);
                
                if (voteCountElement) {
                    voteCountElement.textContent = results.total_participants || 0;
                }
            } catch (error) {
                const voteCountElement = document.querySelector(`.vote-count[data-question-id="${question.id}"]`);
                
                if (voteCountElement) {
                    voteCountElement.textContent = '0';
                }
            }
        }
    } catch (error) {
        console.log('Error actualizando contadores de votos:', error);
    }
}

// ================================
// FUNCIONES DE ADMINISTRACIÓN
// ================================

async function checkParticipants() {
    try {        
        const response = await apiCall('/participants/', {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        const statusCircle = document.getElementById('status-circle');
        const statusText = document.getElementById('status-text');
        
        if (response.length === 0) {
            statusCircle.className = 'status-circle error';
            statusText.textContent = 'Sin participantes registrados';
            
            showParticipantsModal('No hay participantes registrados', []);
            notifications.show('No hay participantes en la base de datos', 'error');
        } else {
            statusCircle.className = 'status-circle success';
            statusText.textContent = `${response.length} participantes registrados`;
            
            showParticipantsModal(`${response.length} participantes encontrados`, response);
        }
    } catch (error) {
        const statusCircle = document.getElementById('status-circle');
        const statusText = document.getElementById('status-text');
        
        statusCircle.className = 'status-circle error';
        statusText.textContent = 'Error al verificar';
        
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

window.closeParticipantsModal = function() {
    delete window.changePage;
    delete window.filterParticipants;
    delete window.closeParticipantsModal;
    modals.hide();
};

function showParticipantsModal(title, participants) {
    // Limpiar funciones globales previas
    cleanupModalFunctions();
    
    const participantsPerPage = 25;
    let currentPage = 1;
    let filteredParticipants = [...participants];
    
    function renderPage() {
        const sortedParticipants = [...filteredParticipants].sort((a, b) => {
            if (a.present !== b.present) {
                return b.present - a.present;
            }
            return a.code.localeCompare(b.code);
        });
        
        const startIndex = (currentPage - 1) * participantsPerPage;
        const endIndex = startIndex + participantsPerPage;
        const pageParticipants = sortedParticipants.slice(startIndex, endIndex);
        const totalPages = Math.ceil(filteredParticipants.length / participantsPerPage);
        
        const paginationHTML = totalPages > 1 ? `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: 1rem; background: var(--gray-100); border-radius: 8px;">
                <button onclick="window.changePage(${currentPage - 1})" 
                        ${currentPage === 1 ? 'disabled' : ''} 
                        class="btn btn-secondary" style="padding: 0.5rem 1rem;">
                    ← Anterior
                </button>
                <span style="color: var(--gray-700); font-size: 0.9rem;">
                    Página ${currentPage} de ${totalPages} (${filteredParticipants.length} resultados)
                </span>
                <button onclick="window.changePage(${currentPage + 1})" 
                        ${currentPage === totalPages ? 'disabled' : ''} 
                        class="btn btn-secondary" style="padding: 0.5rem 1rem;">
                    Siguiente →
                </button>
            </div>
        ` : '';
        
        const participantsList = filteredParticipants.length === 0 ? 
            '<p style="text-align: center; color: var(--gray-700); padding: 2rem;">No se encontraron participantes</p>' :
            `<div style="max-height: 400px; overflow-y: auto; border: 1px solid var(--gray-300); border-radius: 12px;">
                ${pageParticipants.map(p => `
                    <div style="padding: 1rem; border-bottom: 1px solid var(--gray-300); display: grid; grid-template-columns: 80px 1fr 60px 90px; gap: 1rem; align-items: center;">
                        <span style="font-weight: 600; color: ${p.present ? 'var(--success-color)' : 'var(--gray-500)'};">${p.code}</span>
                        <span style="overflow: hidden; text-overflow: ellipsis;">${p.name || 'Sin nombre'}</span>
                        <span style="color: var(--primary-color); font-weight: 500; text-align: right;">${p.coefficient || 0}%</span>
                        ${p.present ? `
                            <button class="btn btn-info" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" 
                                    onclick="closeParticipantsModal(); setTimeout(() => showVoterManagementModal('${p.code}'), 300);">
                                👤 Gestionar
                            </button>
                        ` : `
                            <span style="color: var(--gray-400); font-size: 0.8rem;">No presente</span>
                        `}
                    </div>
                `).join('')}
            </div>`;
        
        return `${paginationHTML}${participantsList}`;
    }
    
    modals.show({
        title: title,
        size: 'large',
        content: `
            <input type="text" id="participant-search" placeholder="Buscar por código o nombre..." 
                   style="width: 100%; padding: 0.8rem; margin-bottom: 1rem; border: 2px solid var(--gray-300); border-radius: 8px;"
                   oninput="window.filterParticipants(this.value)">
            <div id="participants-content">
                ${renderPage()}
            </div>
        `,
        actions: [
            {
                text: 'Cerrar',
                class: 'btn-secondary',
                handler: 'closeParticipantsModal()'
            }
        ]
    });
    
    // Funciones del modal con namespace seguro
    window.changePage = (newPage) => {
        const totalPages = Math.ceil(filteredParticipants.length / participantsPerPage);
        if (newPage >= 1 && newPage <= totalPages) {
            currentPage = newPage;
            const content = document.getElementById('participants-content');
            if (content) {
                content.innerHTML = renderPage();
            }
        }
    };
    
    window.filterParticipants = (searchTerm) => {
        if (!searchTerm.trim()) {
            filteredParticipants = [...participants];
        } else {
            const term = searchTerm.toLowerCase();
            filteredParticipants = participants.filter(p => 
                p.code.toLowerCase().includes(term) ||
                (p.name || '').toLowerCase().includes(term)
            );
        }
        currentPage = 1;
        const content = document.getElementById('participants-content');
        if (content) {
            content.innerHTML = renderPage();
        }
    };
}

function cleanupModalFunctions() {
    // Limpiar funciones globales previas
    delete window.changePage;
    delete window.filterParticipants;
    delete window.saveConjuntoName;
    delete window.modalResolve;
    delete window.powerResolveCallback;
}

window.closeParticipantsModal = function() {
    cleanupModalFunctions();
    modals.hide();
};

async function uploadExcel() {
    const fileInput = document.getElementById('excel-file');
    const file = fileInput.files[0];
    
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
        notifications.show('Subiendo archivo...', 'info');
        
        const response = await fetch(`${API_BASE}/participants/upload-xlsx`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminToken}`
            },
            body: formData
        });

        if (!response.ok) {
            throw new Error('Error al subir archivo');
        }

        const result = await response.json();
        const statusDiv = document.getElementById('upload-status');
        statusDiv.innerHTML = `<div style="color: var(--success-color); margin-top: 1rem;">✅ ${result.inserted} participantes cargados correctamente</div>`;
                
        if (result.inserted > 0) {
            const statusCircle = document.getElementById('status-circle');
            const statusText = document.getElementById('status-text');
            statusCircle.className = 'status-circle success';
            statusText.textContent = `${result.inserted} participantes registrados`;
        }
        
        await loadAforoData();
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
        const statusDiv = document.getElementById('upload-status');
        statusDiv.innerHTML = `<div style="color: var(--danger-color); margin-top: 1rem;">❌ ${error.message}</div>`;
    }
}

// ================================
// FUNCIONES DE VOTACIÓN (ADMIN)
// ================================

function selectVotingType(type) {
    // Actualizar UI de selección de tipo
    document.querySelectorAll('.type-option').forEach(option => {
        option.classList.remove('selected');
    });
    document.querySelector(`[data-type="${type}"]`).classList.add('selected');

    // Mostrar/ocultar configuraciones
    const multipleConfig = document.getElementById('multiple-config');
    const optionsSection = document.getElementById('options-section');
    const questionInput = document.getElementById('question-text');
    
    if (type === 'multiple') {
        multipleConfig.classList.add('active');
        optionsSection.classList.add('active');
        questionInput.placeholder = 'Elija el nuevo representante de la Junta Directiva';
        questionInput.value = '';
    } else {
        multipleConfig.classList.remove('active');
        optionsSection.classList.remove('active');
        questionInput.placeholder = '¿Aprueba la propuesta de mejoras en las zonas comunes?';
        questionInput.value = '';
    }
}

function setSelectionMode(mode) {
    // Actualizar botones de toggle
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-mode="${mode}"]`).classList.add('active');

    // Mostrar/ocultar configuración de máximo selecciones
    const maxSelectionsRow = document.getElementById('max-selections-row');
    const maxInput = document.getElementById('max-selections');
    
    if (mode === 'single') {
        maxInput.value = 1;
        maxInput.disabled = true;
        if (maxSelectionsRow) {
            maxSelectionsRow.style.display = 'none';
        }
    } else {
        maxInput.value = 2;
        maxInput.disabled = false;
        if (maxSelectionsRow) {
            maxSelectionsRow.style.display = 'flex';
        }
    }
}

function addNewOption(text = '') {
    const optionsList = document.getElementById('options-list');
    const currentOptions = optionsList.querySelectorAll('.option-item').length;
    
    const optionHTML = AdminComponents.createOptionItem(currentOptions + 1, text);
    optionsList.insertAdjacentHTML('beforeend', optionHTML);
    
    // Focus en el nuevo input si no tiene texto
    if (!text) {
        const newInput = optionsList.lastElementChild.querySelector('.option-text');
        newInput.focus();
    }
    
    updateOptionNumbers();
}

function setupOptionInputListeners() {
    // Agregar listener para Enter en inputs de opciones
    document.addEventListener('keypress', function(e) {
        if (e.target.classList.contains('option-text') && e.key === 'Enter') {
            e.preventDefault();
            addNewOption();
        }
    });
    setupOptionInputListeners();
}

function removeOptionItem(button) {
    const optionsList = document.getElementById('options-list');
    if (optionsList.querySelectorAll('.option-item').length <= 2) {
        notifications.show('Debe mantener al menos 2 opciones', 'error');
        return;
    }
    
    button.closest('.option-item').remove();
    updateOptionNumbers();
}

function updateOptionNumbers() {
    document.querySelectorAll('.option-item').forEach((item, index) => {
        const numberElement = item.querySelector('.option-number');
        if (numberElement) {
            numberElement.textContent = index + 1;
        }
        item.setAttribute('data-option-number', index + 1);
    });
}

async function createNewVoting() {
    const questionText = document.getElementById('question-text').value.trim();
    const selectedType = document.querySelector('.type-option.selected').getAttribute('data-type');
    
    if (!questionText) {
        notifications.show('Por favor ingrese el texto de la pregunta', 'error');
        return;
    }
    
    const questionData = {
        text: questionText,
        type: selectedType
    };

    if (selectedType === 'multiple') {
        const options = [];
        document.querySelectorAll('.option-text').forEach(input => {
            const text = input.value.trim();
            if (text) {
                options.push(text);
            }
        });
        
        if (options.length < 2) {
            notifications.show('Ingrese al menos 2 opciones para elección múltiple', 'error');
            return;
        }
        
        questionData.options = options;
        
        const maxSelections = parseInt(document.getElementById('max-selections').value) || 1;
        const allowMultiple = maxSelections > 1;

        questionData.allow_multiple = allowMultiple;
        questionData.max_selections = maxSelections;
        
        if (maxSelections > options.length) {
            notifications.show('El máximo de selecciones no puede ser mayor al número de opciones', 'error');
            return;
        }
    }

    // Verificar tiempo límite PARA AMBOS TIPOS (yesno y multiple) - VERSIÓN SEGURA
    let timerEnabled = false;
    
    // Intentar con la nueva UI de botones
    const activeTimerBtn = document.querySelector('.timer-toggle-btn.active');
    if (activeTimerBtn) {
        timerEnabled = activeTimerBtn.getAttribute('data-enabled') === 'true';
    } else {
        // Fallback a checkbox si existe
        const enableTimerCheckbox = document.getElementById('enable-timer');
        timerEnabled = enableTimerCheckbox ? enableTimerCheckbox.checked : false;
    }
    
    if (timerEnabled) {
        const timeLimitInput = document.getElementById('time-limit-minutes');
        if (timeLimitInput) {
            const timeLimit = parseInt(timeLimitInput.value);
            if (timeLimit && timeLimit > 0) {
                questionData.time_limit_minutes = timeLimit;
            }
        }
    }

    try {
        await apiCall('/voting/questions', {
            method: 'POST',
            body: JSON.stringify(questionData)
        });

        // Limpiar formulario - CON VALIDACIONES
        const questionTextInput = document.getElementById('question-text');
        if (questionTextInput) questionTextInput.value = '';
        
        const optionsList = document.getElementById('options-list');
        if (optionsList) optionsList.innerHTML = '';
        
        const maxSelectionsInput = document.getElementById('max-selections');
        if (maxSelectionsInput) maxSelectionsInput.value = '1';
        
        // Limpiar timer (ambas versiones)
        const enableTimerCheckbox = document.getElementById('enable-timer');
        if (enableTimerCheckbox) enableTimerCheckbox.checked = false;
        
        const timerConfig = document.getElementById('timer-config');
        if (timerConfig) timerConfig.style.display = 'none';
        
        const timeLimitInput = document.getElementById('time-limit-minutes');
        if (timeLimitInput) timeLimitInput.value = '15';
        
        // Resetear botones de timer si existen
        document.querySelectorAll('.timer-toggle-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-enabled') === 'false') {
                btn.classList.add('active');
                btn.style.background = 'var(--gray-100)';
            } else {
                btn.style.background = 'white';
            }
        });
        
        const minutesContainer = document.getElementById('timer-minutes-container');
        if (minutesContainer) {
            minutesContainer.style.opacity = '0.5';
            minutesContainer.style.pointerEvents = 'none';
        }

        notifications.show('Votación creada y activada', 'success');
        await loadActiveQuestions();

        // Resetear estado visual del timer
        document.querySelectorAll('.timer-toggle-btn').forEach(btn => {
            btn.classList.remove('active');
            btn.style.background = 'white';
            btn.style.borderColor = 'var(--gray-300)';
            btn.style.color = 'var(--gray-600)';
            
            if (btn.getAttribute('data-enabled') === 'false') {
                btn.classList.add('active');
                btn.style.background = 'var(--danger-color)';
                btn.style.borderColor = 'var(--danger-color)';
                btn.style.color = 'white';
            }
        });
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function toggleVotingStatus(questionId) {
    try {
        await apiCall(`/voting/questions/${questionId}/toggle`, { method: 'PUT' });
        await loadActiveQuestions();
        notifications.show('Estado de votación actualizado', 'success');
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function viewVotingResults(questionId) {
    try {
        const results = await apiCall(`/voting/results/${questionId}`);
        const questionData = await apiCall(`/voting/questions/active`);
        const question = questionData.find(q => q.id === questionId);
        
        const contentHTML = `
            <div style="background: linear-gradient(135deg, var(--danger-color), #764ba2); color: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <h3 style="margin: 0 0 8px 0; font-size: 1.1rem;">${results.question_text}</h3>
                <div style="display: flex; gap: 15px; font-size: 0.85rem;">
                    <span>Participantes: <span id="live-participants-${questionId}">${results.total_participants}</span> de ${results.total_registered}</span>
                    <span>Coeficiente: <span id="live-coefficient-${questionId}">${results.total_participant_coefficient}%</span></span>
                    ${question && question.time_limit_minutes ?
                    `
                        <span id="live-timer-${questionId}" style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 8px; font-size: 0.8rem;">
                            ⏰ ${question.time_remaining_seconds > 0 ? 
                                `Tiempo restante: ${Math.floor(question.time_remaining_seconds/60)}:${String(question.time_remaining_seconds%60).padStart(2,'0')}` 
                                : 'Tiempo agotado'}
                        </span>
                    ` : ''}
                </div>
            </div>
            
            <div id="live-results-${questionId}" style="max-height: 250px; overflow-y: auto;">
                ${generateResultsHTML(results)}
            </div>
        `;

        modals.show({
            title: `Resultados`,
            content: contentHTML,
            size: 'large'
        });
        
        startLiveResultsUpdate(questionId, question ? question.time_limit_minutes : false);
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

function generateResultsHTML(results) {
    if (!results.results || results.results.length === 0) {
        return '<p style="text-align: center; color: var(--gray-600); padding: 1rem;">Sin votos registrados</p>';
    }
    
    return results.results.map(result => `
        <div style="display: flex; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--gray-200);">
            <div style="flex: 0 0 40px; font-weight: 600; color: var(--gray-800);">${result.answer || 'Sin respuesta'}</div>
            <div style="flex: 1; margin: 0 8px; height: 6px; background: var(--gray-200); border-radius: 3px; overflow: hidden;">
                <div style="height: 100%; background: linear-gradient(90deg, var(--danger-color), #f87171); border-radius: 3px; width: ${result.percentage}%; transition: width 0.4s ease;"></div>
            </div>
            <div style="flex: 0 0 120px; text-align: right; font-size: 0.85rem;">
                <span style="font-weight: 600; color: var(--gray-700);">${result.votes} votos</span>
                <span style="color: var(--gray-500);"> | ${result.percentage}%</span>
            </div>
        </div>
    `).join('');
}
let liveUpdateInterval = null;

function startLiveResultsUpdate(questionId, hasTimer) {
    // Limpiar intervalo anterior
    if (liveUpdateInterval) {
        clearInterval(liveUpdateInterval);
    }
    
    liveUpdateInterval = setInterval(async () => {
        try {
            // Verificar si el modal sigue abierto
            if (!document.getElementById(`live-results-${questionId}`)) {
                clearInterval(liveUpdateInterval);
                return;
            }
            
            const results = await apiCall(`/voting/results/${questionId}`);
            
            // Actualizar participantes
            const participantsSpan = document.getElementById(`live-participants-${questionId}`);
            if (participantsSpan) {
                participantsSpan.textContent = results.total_participants;
            }
            
            // Actualizar coeficiente
            const coefficientSpan = document.getElementById(`live-coefficient-${questionId}`);
            if (coefficientSpan) {
                coefficientSpan.textContent = `${results.total_participant_coefficient}%`;
            }
            
            // Actualizar resultados
            const resultsDiv = document.getElementById(`live-results-${questionId}`);
            if (resultsDiv) {
                resultsDiv.innerHTML = generateResultsHTML(results);
            }
            
            // Actualizar timer si existe
            if (hasTimer) {
                const timerDiv = document.getElementById(`live-timer-${questionId}`);
                if (timerDiv) {
                    const questionData = await apiCall(`/voting/questions/active`);
                    const question = questionData.find(q => q.id === questionId);
                    
                    if (question && question.time_remaining_seconds !== null) {
                        if (question.time_remaining_seconds <= 0) {
                            timerDiv.innerHTML = '⏰ Tiempo agotado';
                            timerDiv.style.background = 'rgba(239, 68, 68, 0.2)';
                        } else {
                            const minutes = Math.floor(question.time_remaining_seconds / 60);
                            const seconds = question.time_remaining_seconds % 60;
                            timerDiv.innerHTML = `⏰ Tiempo restante: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                        }
                    }
                }
            }
            
        } catch (error) {
            console.error('Error actualizando resultados en vivo:', error);
        }
    }, 1000); // Cada segundo
}

async function updateLiveResults(questionId) {
    try {
        const results = await apiCall(`/voting/results/${questionId}`);
        
        // Actualizar solo los elementos que cambian
        const participantsSpan = document.getElementById(`live-participants-${questionId}`);
        if (participantsSpan) participantsSpan.textContent = results.total_participants;
        
        const coefficientSpan = document.getElementById(`live-coefficient-${questionId}`);
        if (coefficientSpan) coefficientSpan.textContent = `${results.total_participant_coefficient}%`;
        
        const resultsDiv = document.getElementById(`live-results-${questionId}`);
        if (resultsDiv) resultsDiv.innerHTML = generateResultsHTML(results);
        
    } catch (error) {
        console.error('Error actualizando resultados:', error);
    }
}

// Limpiar al cerrar modal
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        if (liveUpdateInterval) {
            clearInterval(liveUpdateInterval);
            liveUpdateInterval = null;
        }
    }
});

async function deleteVoting(questionId) {
    try {
        console.log('🗑️ Iniciando eliminación de votación:', questionId);
        
        const confirmed = await modals.confirm(
            '¿Eliminar esta votación?\n\nSe borrarán también todos los votos registrados.',
            'Confirmar eliminación'
        );
        
        console.log('Respuesta de confirmación:', confirmed);
        
        if (!confirmed) {
            console.log('Eliminación cancelada');
            return;
        }
                
        try {
            await apiCall(`/voting/questions/${questionId}`, { method: 'DELETE' });
            await loadActiveQuestions();
            notifications.show('Votación eliminada correctamente', 'success');
        } catch (error) {
            console.error('Error eliminando votación:', error);
            notifications.show(`Error al eliminar: ${error.message}`, 'error');
        }
        
    } catch (error) {
        console.error('Error con modal de confirmación:', error);
        notifications.show('Error en la confirmación', 'error');
    }
}
function showExtendTimeModal(questionId, questionText) {
    modals.show({
        title: '⏰ Extender Tiempo de Votación',
        content: `
            <p style="margin-bottom: 1rem;"><strong>Pregunta:</strong> ${questionText}</p>
            <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">Minutos adicionales:</label>
            <input type="number" id="extend-minutes-input" class="modal-input" 
                   placeholder="15" min="1" max="120" value="15">
            <p style="color: var(--gray-600); font-size: 0.9rem; margin-top: 0.5rem;">
                Máximo 120 minutos adicionales
            </p>
        `,
        actions: [
            {
                text: 'Cancelar',
                class: 'btn-secondary',
                handler: 'modals.hide()'
            },
            {
                text: 'Extender Tiempo',
                class: 'btn-warning',
                handler: `extendVotingTime(${questionId})`
            }
        ]
    });
}

async function extendVotingTime(questionId) {
    const minutes = parseInt(document.getElementById('extend-minutes-input').value);
    
    if (!minutes || minutes < 1 || minutes > 120) {
        notifications.show('Ingrese entre 1 y 120 minutos', 'error');
        return;
    }
    
    try {
        console.log('Enviando extensión de tiempo:', questionId, minutes);
        
        await apiCall(`/voting/questions/${questionId}/extend-time`, {
            method: 'PUT',
            body: JSON.stringify({ extra_minutes: minutes })
        });
        
        modals.hide();
        await loadActiveQuestions(); // Recargar para ver cambios
        notifications.show(`⏰ Tiempo extendido por ${minutes} minutos`, 'success');
        
    } catch (error) {
        console.error('Error extendiendo tiempo:', error);
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

function showBroadcastModal() {
    modals.show({
        title: 'Mensaje a Votantes',
        content: `
            <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">Mensaje:</label>
            <textarea id="broadcast-message" class="modal-input" 
                      style="min-height: 100px; resize: vertical;" 
                      placeholder="Escriba el mensaje para todos los votantes..."></textarea>
            
            <label style="display: block; margin-bottom: 0.5rem; margin-top: 1rem; font-weight: 500;">Tipo:</label>
            <select id="broadcast-type" class="modal-input">
                <option value="info">Información</option>
                <option value="success">Éxito</option>
                <option value="warning">Advertencia</option>
                <option value="error">Error</option>
            </select>
        `,
        actions: [
            {
                text: 'Cancelar',
                class: 'btn-secondary',
                handler: 'modals.hide()'
            },
            {
                text: 'Enviar Mensaje',
                class: 'btn-primary',
                handler: 'sendBroadcastMessage()'
            }
        ]
    });
}

async function sendBroadcastMessage() {
    const message = document.getElementById('broadcast-message').value.trim();
    const type = document.getElementById('broadcast-type').value;
    
    if (!message) {
        notifications.show('Escriba un mensaje', 'error');
        return;
    }
    
    try {
        const response = await apiCall('/admin/broadcast-message', {
            method: 'POST',
            body: JSON.stringify({
                text: message,
                type: type,
                duration: 10000
            })
        });
        
        modals.hide();
        notifications.show(`📢 Mensaje enviado a ${response.recipients} votantes`, 'success');
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function editVoting(questionId) {
    try {
        const questions = await apiCall('/voting/questions/active');
        const question = questions.find(q => q.id === questionId);
        
        if (!question) {
            notifications.show('Votación no encontrada', 'error');
            return;
        }
        
        if (!question.closed) {
            notifications.show('Solo se pueden editar votaciones cerradas', 'error');
            return;
        }
        
        showEditVotingModal(question);
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

function showEditVotingModal(question) {
    const isMultiple = question.type === 'multiple';
    const options = question.options || [];
    
    let contentHTML = `
        <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">Pregunta:</label>
        <input type="text" id="edit-question-text" class="modal-input" value="${question.text}">
    `;
    
    if (isMultiple) {
        contentHTML += `
            <label style="display: block; margin-bottom: 0.5rem; margin-top: 1rem; font-weight: 500;">Opciones (una por línea):</label>
            <textarea id="edit-candidates-list" style="width: 100%; min-height: 150px; padding: 0.8rem; border: 2px solid var(--gray-300); border-radius: 8px; margin-bottom: 1rem; resize: vertical;">${options.map(opt => opt.text).join('\n')}</textarea>
            
            ${question.allow_multiple ? `
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">Máximo selecciones:</label>
                <input type="number" id="edit-max-selections" class="modal-input" value="${question.max_selections}" min="1" style="width: 120px;">
            ` : ''}
        `;
    }
    
    modals.show({
        title: '✏️ Editar Votación',
        content: contentHTML,
        actions: [
            {
                text: 'Cancelar',
                class: 'btn-secondary',
                handler: 'modals.hide()'
            },
            {
                text: 'Guardar Cambios',
                class: 'btn-primary',
                handler: `saveEditedVoting(${question.id})`
            }
        ]
    });
    
    window.saveEditedVoting = async (questionId) => {
        const newText = document.getElementById('edit-question-text').value.trim();
        
        if (!newText) {
            notifications.show('La pregunta no puede estar vacía', 'error');
            return;
        }
        
        const updateData = { text: newText };
        
        const candidatesList = document.getElementById('edit-candidates-list');
        if (candidatesList) {
            const newOptions = candidatesList.value.split('\n')
                .map(c => c.trim())
                .filter(c => c.length > 0);
                
            if (newOptions.length < 2) {
                notifications.show('Debe tener al menos 2 opciones', 'error');
                return;
            }
            
            updateData.options = newOptions;
            
            const maxSelectionsInput = document.getElementById('edit-max-selections');
            if (maxSelectionsInput) {
                const maxSelections = parseInt(maxSelectionsInput.value);
                if (maxSelections > newOptions.length) {
                    notifications.show('El máximo de selecciones no puede ser mayor al número de opciones', 'error');
                    return;
                }
                updateData.max_selections = maxSelections;
            }
        }
        
        try {
            await apiCall(`/voting/questions/${questionId}`, {
                method: 'PUT',
                body: JSON.stringify(updateData)
            });
            
            modals.hide();
            delete window.saveEditedVoting;
            await loadActiveQuestions();
            notifications.show('Votación actualizada correctamente', 'success');
        } catch (error) {
            notifications.show(`Error: ${error.message}`, 'error');
        }
    };
}

// ================================
// FUNCIONES DE CONFIGURACIÓN
// ================================

async function showDeleteCodeModal() {
    try {
        const participants = await apiCall('/participants/');
        const registeredUsers = participants.filter(p => p.present);
        
        modals.show({
            title: '🚫 Eliminar Código',
            content: `
                <p style="color: var(--gray-700); margin-bottom: 1rem; text-align: center;">
                    Esta acción eliminará el registro de asistencia del código especificado.
                </p>
                
                <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">Código a eliminar:</label>
                <input type="text" id="delete-code-input" class="modal-input" placeholder="Escriba para buscar..." 
                    style="text-transform: uppercase; margin-bottom: 0.5rem;" autocomplete="off">
                <div id="code-suggestions" style="max-height: 150px; overflow-y: auto; border: 1px solid var(--gray-300); border-radius: 6px; display: none;"></div>
            `,
            actions: [
                {
                    text: 'Cancelar',
                    class: 'btn-secondary', 
                    handler: 'modals.hide()'
                },
                {
                    text: 'Eliminar',
                    class: 'btn-danger',
                    handler: 'window.processDeleteCode()'
                }
            ]
        });
        
        // Autocompletado
        setTimeout(() => {
            const input = document.getElementById('delete-code-input');
            const suggestions = document.getElementById('code-suggestions');
            
            input.addEventListener('input', (e) => {
                const query = e.target.value.toUpperCase();
                if (query.length === 0) {
                    suggestions.style.display = 'none';
                    return;
                }
                
                const matches = registeredUsers.filter(user => 
                    user.code.toUpperCase().includes(query)
                ).slice(0, 5);
                
                if (matches.length > 0) {
                    suggestions.innerHTML = matches.map(user => `
                        <div onclick="document.getElementById('delete-code-input').value='${user.code}'; this.parentElement.style.display='none';" 
                             style="padding: 0.5rem; cursor: pointer; border-bottom: 1px solid var(--gray-200);" 
                             onmouseover="this.style.background='var(--gray-100)'" onmouseout="this.style.background='white'">
                            <strong>${user.code}</strong> - ${user.name}
                        </div>
                    `).join('');
                    suggestions.style.display = 'block';
                } else {
                    suggestions.style.display = 'none';
                }
            });
        }, 100);
        
    } catch (error) {
        notifications.show('Error cargando usuarios', 'error');
    }
}

async function processDeleteCode() {
    const code = document.getElementById('delete-code-input').value.trim().toUpperCase();
    
    if (!code || !Utils.validateCode(code)) {
        notifications.show('Formato de código inválido. Use formato Torre-Apto (ej: 1-201)', 'error');
        return;
    }
    
    const confirmed = await modals.confirm(
        `¿Eliminar registro del código ${code}?\n\nEsta acción no se puede deshacer.`,
        'Confirmar eliminación'
    );
    
    if (!confirmed) return;
    
    try {
        notifications.show('Eliminando registro...', 'info');
        
        await apiCall(`/admin/delete-code/${code}`, {
            method: 'DELETE'
        });
        
        modals.hide();
        await loadAforoData();
        await refreshConnectedUsers();
        notifications.show(`Código ${code} eliminado correctamente`, 'success');
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function showVoterManagementModal(code) {
    try {
        // Obtener info del votante
        const voterInfo = await apiCall(`/admin/voter-info/${code}`);
        const voterVotes = await apiCall(`/admin/voter-votes/${code}`);
        
        const votesHTML = voterVotes.length > 0 ? 
            voterVotes.map(vote => `<div>Pregunta ${vote.question_id}: ${vote.answer}</div>`).join('') :
            '<p>Sin votos registrados</p>';
        
        modals.show({
            title: `👤 Gestión de Votante`,
            content: `
                <div style="margin-bottom: 1rem;">
                    <strong>Código:</strong> ${voterInfo.code}<br>
                    <strong>Nombre:</strong> ${voterInfo.name}<br>
                    <strong>Coeficiente:</strong> ${voterInfo.coefficient}%<br>
                    <strong>Presente:</strong> ${voterInfo.present ? 'Sí' : 'No'}
                </div>
                
                <label style="display: block; margin-bottom: 0.5rem;">Tipo de participación:</label>
                <select id="voter-type-select" class="modal-input">
                    <option value="false" ${!voterInfo.is_power ? 'selected' : ''}>Propietario</option>
                    <option value="true" ${voterInfo.is_power ? 'selected' : ''}>Con Poder</option>
                </select>
                
                <div style="margin-top: 1rem; padding: 1rem; background: var(--gray-50); border-radius: 8px;">
                    <strong>Votos registrados:</strong><br>
                    ${voterVotes.length > 0 ? 
                        voterVotes.map(vote => `
                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #eee;">
                                <span>Pregunta ${vote.question_id}: ${vote.answer}</span>
                                <div>
                                    <button class="btn btn-warning" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; margin-right: 0.5rem;" 
                                            onclick="showEditVoteModal('${code}', ${vote.question_id}, '${vote.answer}')">
                                        ✏️ Editar
                                    </button>
                                    <button class="btn btn-danger" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;" 
                                            onclick="clearVoterVote('${code}', ${vote.question_id})">
                                        🗑️ Borrar
                                    </button>
                                </div>
                            </div>
                        `).join('') : 
                        '<p>Sin votos registrados</p>'
                    }
                </div>
            `,
            actions: [
                {
                    text: 'Cancelar',
                    class: 'btn-secondary',
                    handler: 'modals.hide()'
                },
                {
                    text: 'Guardar Cambios',
                    class: 'btn-primary',
                    handler: `saveVoterChanges('${code}')`
                }
            ]
        });
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function saveVoterChanges(code) {
    const isPower = document.getElementById('voter-type-select').value === 'true';
    
    try {
        await apiCall(`/admin/edit-voter/${code}`, {
            method: 'PUT',
            body: JSON.stringify({ is_power: isPower })
        });
        
        modals.hide();
        await loadAforoData(); // Refrescar estadísticas
        notifications.show('Votante actualizado correctamente', 'success');
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function clearVoterVote(code, questionId) {
    const confirmed = await modals.confirm(
        `¿Eliminar el voto del código ${code} en la pregunta ${questionId}?`,
        'Confirmar eliminación de voto'
    );
    
    if (!confirmed) return;
    
    try {
        await apiCall(`/admin/clear-vote/${code}/${questionId}`, {
            method: 'DELETE'
        });
        
        notifications.show('Voto eliminado correctamente', 'success');
        // Refrescar el modal
        modals.hide();
        setTimeout(() => showVoterManagementModal(code), 500);
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function showEditVoteModal(code, questionId, currentAnswer) {
    try {
        // Obtener opciones de la pregunta
        const questions = await apiCall('/voting/questions/active');
        const question = questions.find(q => q.id === questionId);
        
        if (!question) {
            notifications.show('Pregunta no encontrada', 'error');
            return;
        }
        
        let optionsHTML = '';
        if (question.options && question.options.length > 0) {
            optionsHTML = `
                <label style="display: block; margin-bottom: 0.5rem;">Nueva respuesta:</label>
                <select id="new-answer-select" class="modal-input">
                    ${question.options.map(opt => `
                        <option value="${opt.text}" ${opt.text === currentAnswer ? 'selected' : ''}>
                            ${opt.text}
                        </option>
                    `).join('')}
                </select>
            `;
        } else {
            optionsHTML = `
                <label style="display: block; margin-bottom: 0.5rem;">Nueva respuesta:</label>
                <input type="text" id="new-answer-input" class="modal-input" 
                       placeholder="Nueva respuesta" value="${currentAnswer}">
            `;
        }
        
        modals.show({
            title: `✏️ Editar Voto - ${code}`,
            content: `
                <p><strong>Pregunta:</strong> ${question.text}</p>
                <p><strong>Respuesta actual:</strong> ${currentAnswer}</p>
                <hr style="margin: 1rem 0;">
                ${optionsHTML}
            `,
            actions: [
                {
                    text: 'Cancelar',
                    class: 'btn-secondary',
                    handler: 'modals.hide()'
                },
                {
                    text: 'Guardar Cambio',
                    class: 'btn-primary',
                    handler: `saveVoteEdit('${code}', ${questionId})`
                }
            ]
        });
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function saveVoteEdit(code, questionId) {
    const newAnswerSelect = document.getElementById('new-answer-select');
    const newAnswerInput = document.getElementById('new-answer-input');
    const newAnswer = newAnswerSelect ? newAnswerSelect.value : newAnswerInput.value.trim();
    
    if (!newAnswer) {
        notifications.show('Debe seleccionar/ingresar una respuesta', 'error');
        return;
    }
    
    try {
        await apiCall(`/admin/edit-vote/${code}/${questionId}`, {
            method: 'PUT',
            body: JSON.stringify({ new_answer: newAnswer })
        });
        
        modals.hide();
        notifications.show('Voto actualizado correctamente', 'success');
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function downloadReports() {
    try {
        // Generar PDF
        const pdfResponse = await apiCall('/participants/asistencia/pdf', {
            method: 'POST'
        });

        if (!pdfResponse.ok) {
            throw new Error('Error generando PDF');
        }

        // Generar Excel
        const excelResponse = await apiCall('/participants/asistencia/xlsx', {
            method: 'POST'
        });

        if (!excelResponse.ok) {
            throw new Error('Error generando Excel');
        }

        // Obtener nombre del conjunto para los archivos
        const conjuntoData = await apiCall('/participants/conjunto/nombre');
        const nombreArchivo = (conjuntoData.nombre || 'conjunto').replace(/\s+/g, '_');

        // Descargar PDF
        const pdfBlob = await pdfResponse.blob();
        const pdfUrl = window.URL.createObjectURL(pdfBlob);
        const pdfLink = document.createElement('a');
        pdfLink.href = pdfUrl;
        pdfLink.download = `reporte_completo_${nombreArchivo}.pdf`;
        pdfLink.click();
        window.URL.revokeObjectURL(pdfUrl);

        // Descargar Excel
        const excelBlob = await excelResponse.blob();
        const excelUrl = window.URL.createObjectURL(excelBlob);
        const excelLink = document.createElement('a');
        excelLink.href = excelUrl;
        excelLink.download = `asistencia_${nombreArchivo}.xlsx`;
        excelLink.click();
        window.URL.revokeObjectURL(excelUrl);

        notifications.show('Archivos descargados: PDF y Excel', 'success');
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function resetDatabase() {
    const confirmed = await modals.confirm(
        '⚠️ ¿Resetear TODA la base de datos?\n\nSe cerrarán TODAS las sesiones activas y deberán volver a ingresar.',
        'Confirmar reset completo'
    );
    
    if (!confirmed) return;

    try {
        await apiCall('/voting/admin/reset', {method: 'DELETE'});

        // Limpiar estado local
        const statusCircle = document.getElementById('status-circle');
        const statusText = document.getElementById('status-text');
        statusCircle.className = 'status-circle';
        statusText.textContent = 'Estado: Sin verificar';
        
        notifications.show('Base de datos limpiada completamente', 'success');

        // Reset completo del estado local
        clearTokens();
        adminToken = null;
        voterToken = null;
        currentUser = null;
        isAdmin = false;

        if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
        }

        // Limpiar formularios
        document.getElementById('access-code').value = '';
        document.getElementById('upload-status').innerHTML = '';

        // Limpiar displays de conjunto
        document.querySelectorAll('#conjunto-name-display, #conjunto-name-small').forEach(el => {
            if (el) el.textContent = 'Conjunto Residencial';
        });

        // También limpiar el botón de estado
        const estadoDisplay = document.getElementById('conjunto-display-estado');
        if (estadoDisplay) {
            estadoDisplay.textContent = 'Configurar Nombre del Conjunto';
        }

        // Cerrar modales activos
        modals.hide();

        // Volver a pantalla inicial
        setTimeout(() => {
            showScreen('welcome-screen');
        }, 1000);

    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
        // En caso de error severo, recargar la página
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    }
}

// ================================
// EVENT LISTENERS Y INICIALIZACIÓN
// ================================

function setupMainEventListeners() {
    // Limpiar listeners previos
    const buttons = ['logout-button', 'register-btn', 'voting-btn', 'admin-btn'];
    buttons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            // Clonar elemento para remover todos los listeners
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
        }
    });
    
    // Agregar listeners limpios
    document.getElementById('logout-button').addEventListener('click', logout);
    document.getElementById('register-btn').addEventListener('click', safeExecute(registerAttendance));
    document.getElementById('voting-btn').addEventListener('click', safeExecute(accessVoting));
    document.getElementById('admin-btn').addEventListener('click', safeExecute(showAdminLogin));
    
    // Input de código con Enter
    const accessCode = document.getElementById('access-code');
    accessCode.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            safeExecute(accessVoting)();
        }
    });
    
    // Prevenir envío de formularios
    document.addEventListener('submit', (e) => {
        e.preventDefault();
    });
}

function safeExecute(fn) {
    return async function(...args) {
        try {
            await fn.apply(this, args);
        } catch (error) {
            console.error('Error ejecutando función:', error);
            notifications.show('Ha ocurrido un error. Por favor reintente.', 'error');
        }
    };
}

async function tryRestoreAdminSession() {
    const savedAdminToken = getToken('admin');
    if (savedAdminToken) {
        adminToken = savedAdminToken;
        isAdmin = true;
        try {
            // Verificar que el token siga válido
            await apiCall('/voting/aforo');
            await showAdminScreen();
            notifications.show('Sesión de administrador restaurada', 'success');
        } catch (error) {
            clearTokens();
            adminToken = null;
            isAdmin = false;
            notifications.show('Sesión expirada, ingrese nuevamente', 'info');
        }
    }
}

function setupVisualEffects() {
    // Agregar animaciones de loading a botones
    document.querySelectorAll('.btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            if (!this.disabled) {
                // Efecto ripple ya se maneja en components.js
                this.style.transform = 'scale(0.98)';
                setTimeout(() => {
                    this.style.transform = '';
                }, 150);
            }
        });
    });
    
    // Scroll suave para navegación
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }
        });
    });
}

// ================================
// SISTEMA DE MONITOREO
// ================================

let monitoringInterval = null;
let activityLog = [];

async function refreshServerStatus() {
    try {
        const status = await apiCall('/monitoring/server-status');
        renderServerStatus(status);
        renderDatabaseMetrics(status);
    } catch (error) {
        console.error('Error loading server status:', error);
        document.getElementById('server-status-display').innerHTML = 
            '<p style="color: var(--danger-color);">❌ Error obteniendo estado del servidor</p>';
    }
}

function renderServerStatus(data) {
    const container = document.getElementById('server-status-display');
    const statusColor = {
        'healthy': 'var(--success-color)',
        'moderate': 'var(--warning-color)',
        'warning': 'var(--danger-color)',
        'critical': 'var(--danger-color)',
        'error': 'var(--danger-color)'
    }[data.status] || 'var(--gray-500)';
    
    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
            <div class="stat-card" style="border-left: 4px solid ${statusColor};">
                <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">${data.status_text}</div>
                <div class="stat-label">Estado General</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${data.load_percentage || 0}%</div>
                <div class="stat-label">Carga del Sistema</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${data.websockets?.total_connections || 0}</div>
                <div class="stat-label">Conexiones Activas</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${data.limits?.max_connections || 0}</div>
                <div class="stat-label">Límite Máximo</div>
            </div>
        </div>
        
        ${data.load_percentage > 80 ? `
            <div style="background: linear-gradient(135deg, var(--danger-color), var(--danger-dark)); color: white; padding: 1rem; border-radius: 8px; margin-top: 1rem;">
                <strong>⚠️ Advertencia de Sobrecarga:</strong>
                <p>El servidor está cerca de su capacidad máxima. Considere limitar nuevos accesos.</p>
            </div>
        ` : ''}
        
        <div style="font-size: 0.9rem; color: var(--gray-600); margin-top: 1rem;">
            Última actualización: ${new Date().toLocaleTimeString('es-CO')}
        </div>
    `;
}

function renderDatabaseMetrics(data) {
    const container = document.getElementById('database-metrics');
    
    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem;">
            <div class="stat-card">
                <div class="stat-number">${data.connection_pool?.status === 'healthy' ? '🟢' : '🔴'}</div>
                <div class="stat-label">Pool BD</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${data.limits?.pool_max || 0}</div>
                <div class="stat-label">Pool Máximo</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${data.cache?.entries || 0}</div>
                <div class="stat-label">Cache Entradas</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${data.database?.status === 'healthy' ? '✅' : '❌'}</div>
                <div class="stat-label">Estado BD</div>
            </div>
        </div>
    `;
}

function startMonitoring() {
    if (monitoringInterval) return;
    
    monitoringInterval = setInterval(async () => {
        if (isAdmin) {
            const activeTab = document.querySelector('.tab-button.active');
            if (activeTab && activeTab.getAttribute('data-tab') === 'monitoreo') {
                await refreshServerStatus();
            }
            if (activeTab && activeTab.getAttribute('data-tab') === 'configuracion') {
                await refreshConnectedUsers();
            }
        }
    }, 3000);
}

function stopMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
}

function addActivityLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('es-CO');
    const color = {
        'info': 'var(--info-color)',
        'warning': 'var(--warning-color)',
        'error': 'var(--danger-color)',
        'success': 'var(--success-color)'
    }[type] || 'var(--gray-600)';
    
    activityLog.unshift({ message, type, timestamp, color });
    
    // Mantener solo los últimos 50 logs
    if (activityLog.length > 50) {
        activityLog = activityLog.slice(0, 50);
    }
    
    updateActivityDisplay();
}

function updateActivityDisplay() {
    const container = document.getElementById('activity-log');
    if (!container) return;
    
    if (activityLog.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--gray-600);">Esperando actividad...</p>';
        return;
    }
    
    container.innerHTML = activityLog.map(log => `
        <div style="padding: 0.5rem; border-bottom: 1px solid var(--gray-300); display: flex; justify-content: space-between; align-items: center;">
            <span style="color: ${log.color};">${log.message}</span>
            <span style="color: var(--gray-500); font-size: 0.8rem;">${log.timestamp}</span>
        </div>
    `).join('');
}

function loadDemoVotingQuestions() {
    const demoQuestions = [
        {
            id: 9996,
            text: "[DEMO] ¿Aprueba usted la propuesta de mejoras en las zonas comunes del conjunto?",
            type: "yesno",
            closed: false,
            options: [{text: 'SÍ'}, {text: 'No'}]
        },
        {
            id: 9997,
            text: "[DEMO] Elija el nuevo representante de la Junta Directiva (una sola opción)",
            type: "multiple",
            closed: false,
            allow_multiple: false,
            max_selections: 1,
            options: [
                {text: "Ana María López - Apto 1-201"},
                {text: "Carlos Rodríguez - Apto 2-305"},
                {text: "Diana Torres - Apto 3-102"},
                {text: "Miguel Ángel Ruiz - Apto 1-405"}
            ]
        },
        {
            id: 9998,
            text: "[DEMO] Seleccione las mejoras prioritarias para el próximo año (máximo 3 opciones)",
            type: "multiple",
            closed: false,
            allow_multiple: true,
            max_selections: 3,
            options: [
                {text: "Remodelación de la piscina"},
                {text: "Nuevo gimnasio"},
                {text: "Mejora en jardines y zonas verdes"},
                {text: "Ampliación del parqueadero"},
                {text: "Salón social más grande"},
                {text: "Cancha de tenis"}
            ]
        },
        {
            id: 9999,
            text: "[DEMO] ¿Está de acuerdo con el aumento del 8% en la administración?",
            type: "yesno",
            closed: true, // Esta aparece como cerrada para mostrar el estado
            options: [{text: 'SÍ'}, {text: 'No'}]
        }
    ];
    
    // Renderizar las votaciones demo
    renderVotingQuestions(demoQuestions, new Set()); // Set vacío = no ha votado en ninguna
}

function showTestUserAdminLogin() {
    modals.show({
        title: '🔐 Acceso de Demostración',
        content: `
            <div style="background: rgba(255, 193, 7, 0.1); padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid #ffc107;">
                <strong>⚠️ Usuario de Prueba Detectado</strong>
                <p style="margin: 0.5rem 0 0 0; color: #856404;">
                    Por seguridad, ingrese las credenciales de administrador para acceder al modo demostración.
                </p>
            </div>
            
            <input type="text" id="demo-admin-username" class="modal-input" placeholder="Usuario administrador" />
            <input type="password" id="demo-admin-password" class="modal-input" placeholder="Contraseña administrador" />
        `,
        actions: [
            {
                text: 'Cancelar',
                class: 'btn-secondary',
                handler: 'modals.hide()'
            },
            {
                text: 'Acceder a Demo',
                class: 'btn-warning',
                handler: 'validateTestUserAdmin()'
            }
        ]
    });
    
    // Focus y Enter en los inputs
    setTimeout(() => {
        const usernameInput = document.getElementById('demo-admin-username');
        const passwordInput = document.getElementById('demo-admin-password');
        
        [usernameInput, passwordInput].forEach(input => {
            if (input) {
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        validateTestUserAdmin();
                    }
                });
            }
        });
        
        if (usernameInput) usernameInput.focus();
    }, 100);
}

async function validateTestUserAdmin() {
    const username = document.getElementById('demo-admin-username').value.trim();
    const password = document.getElementById('demo-admin-password').value.trim();
    
    if (!username || !password) {
        notifications.show('Complete usuario y contraseña del administrador', 'error');
        return;
    }

    try {
        // Verificar credenciales de admin
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', password);

        const response = await apiCall('/auth/login/admin', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData
        });

        // Credenciales válidas - activar modo demo
        modals.hide();
        
        // Configurar usuario de prueba
        currentUser = {
            code: CODIGO_PRUEBA,
            name: 'Usuario de Demostración',
            id: 'demo_user',
            coefficient: 1.00
        };
        isAdmin = false; // Importante: NO es admin, solo validó credenciales
        
        // Ir a votaciones
        showScreen('voter-screen');
        
        // Configurar interfaz
        document.getElementById('voter-code').textContent = currentUser.code;
        document.getElementById('voter-name').textContent = `Bienvenido/a, ${currentUser.name}`;
        
        // Agregar info demo
        const userMeta = document.querySelector('.user-meta');
        if (userMeta) {
            // Limpiar elementos previos
            const prevElements = userMeta.querySelectorAll('#voter-coefficient, #voter-conjunto');
            prevElements.forEach(el => el.remove());
            
            // Agregar nuevos
            const coeffElement = document.createElement('span');
            coeffElement.id = 'voter-coefficient';
            coeffElement.textContent = `Coeficiente: ${currentUser.coefficient}%`;
            userMeta.appendChild(coeffElement);
            
            const conjuntoElement = document.createElement('span');
            conjuntoElement.id = 'voter-conjunto';
            conjuntoElement.textContent = '🧪 MODO DEMOSTRACIÓN';
            userMeta.appendChild(conjuntoElement);
        }
        
        // Cargar votaciones demo
        setTimeout(() => {
            loadDemoVotingQuestions();
        }, 500);
        
        notifications.show('🧪 Modo demostración activado con credenciales válidas', 'success');
        
    } catch (error) {
        notifications.show('Credenciales de administrador incorrectas', 'error');
    }
}

let usersRefreshInterval = null;

function startUsersRefreshInterval() {
    if (usersRefreshInterval) return;
    
    usersRefreshInterval = setInterval(async () => {
        if (isAdmin && document.querySelector('.tab-button[data-tab="configuracion"].active')) {
            await refreshConnectedUsers();
        }
    }, 2000); 
}

function stopUsersRefreshInterval() {
    if (usersRefreshInterval) {
        clearInterval(usersRefreshInterval);
        usersRefreshInterval = null;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Limpiar estado previo
    if (window.modalResolve) {
        delete window.modalResolve;
    }
    if (window.powerResolveCallback) {
        delete window.powerResolveCallback;
    }
    
    // Event listeners principales
    setupMainEventListeners();
    
    // Intentar restaurar sesión admin
    await tryRestoreAdminSession();
    
    // Mostrar mensaje de bienvenida
    if (!isAdmin) {
        notifications.show('Sistema iniciado - Ingrese sus credenciales', 'success');
    }
    
    // Configurar efectos visuales
    setupVisualEffects();
});