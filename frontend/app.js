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
            notifications.show('Conexión en tiempo real activada', 'success', 3000);
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
            notifications.show('Conectado en tiempo real', 'success', 3000);
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
    switch (message.type) {
        case 'attendance_registered':
            loadAforoData();
            notifications.show(`Nueva asistencia: ${message.data.code} - ${message.data.name}`, 'info', 5000);
            addActivityLog(`Nueva asistencia: ${message.data.code} - ${message.data.name}`, 'success');
            break;
        case 'vote_registered':
            loadAforoData();
            loadActiveQuestions();
            addActivityLog(`Voto registrado: ${message.data.participant_code}`, 'info');
            break;
        case 'question_created':
            loadActiveQuestions();
            notifications.show('Nueva votación creada', 'success', 4000);
            addActivityLog('Nueva votación creada', 'success');
            break;
        case 'participant_removed':
            loadAforoData();
            notifications.show(`Código eliminado: ${message.data.code}`, 'warning', 4000);
            addActivityLog(`Código eliminado: ${message.data.code}`, 'warning');
            break;
        case 'excel_uploaded':
            loadAforoData();
            notifications.show(`Excel cargado: ${message.data.inserted} participantes`, 'success', 6000);
            addActivityLog(`Excel cargado: ${message.data.inserted} participantes`, 'success');
            break;
        case 'notification':
            notifications.show(message.data.text || 'Notificación del sistema', message.data.type || 'info', message.data.duration || 5000);
            break;
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
}

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
        showTestUserModal();
        return;
    }

    try {
        notifications.show('Verificando código...', 'info');
        
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
        
        const isPower = await showPowerQuestion();
        
        const response = await apiCall('/auth/register-attendance', {
            method: 'POST',
            body: JSON.stringify({ 
                code: code,
                is_power: isPower
            })
        });

        showAttendanceModal(response);
        notifications.show('Asistencia registrada correctamente', 'success');
    } catch (error) {
        console.error('Error en registro:', error);
        
        if (error.message.includes('405') || error.message.includes('Method Not Allowed')) {
            notifications.show('Error técnico del sistema. Por favor contacte al administrador.', 'error');
        } else if (error.message.includes('404') || error.message.includes('not found')) {
            notifications.show('Su código no está registrado en el sistema. Consulte con la administración del conjunto.', 'error');
        } else if (error.message.includes('400') || error.message.includes('already registered')) {
            notifications.show('Su asistencia ya fue registrada previamente.', 'warning');
        } else if (error.message.includes('network') || error.message.includes('fetch')) {
            notifications.show('Error de conexión. Verifique su internet y reintente.', 'error');
        } else {
            notifications.show('Ocurrió un problema técnico. Por favor consulte con el administrador de la asamblea.', 'error');
        }
    }
}

async function accessVoting() {
    const code = document.getElementById('access-code').value.trim().toUpperCase();
    
    if (!code || !Utils.validateCode(code)) {
        notifications.show('Formato de código inválido. Use formato Torre-Apto (ej: 1-201)', 'error');
        return;
    }

    if (code === CODIGO_PRUEBA) {
        currentUser = {
            code: CODIGO_PRUEBA,
            name: 'Usuario de Prueba',
            id: 'test',
            coefficient: 1.00
        };
        isAdmin = false;
        
        notifications.show('Modo demostración activado', 'success');
        showTestUserModal();  
        
        // Actualizar info del usuario directamente
        document.getElementById('voter-code').textContent = currentUser.code;
        document.getElementById('voter-name').textContent = `Bienvenido/a, ${currentUser.name}`;
        
        // Cargar votaciones de prueba
        setTimeout(() => {
            loadVotingQuestions();
        }, 500);
        
        return;
    }

    try {
        notifications.show('Verificando acceso a votaciones...', 'info');
        
        // Verificar que hay participantes en la base
        const dbCheck = await apiCall('/auth/check-database');
        if (!dbCheck.has_participants) {
            notifications.show('No hay participantes registrados en el sistema. El administrador debe cargar la base de datos primero.', 'error');
            return;
        }
        
        const response = await apiCall('/auth/login/voter', {
            method: 'POST',
            body: JSON.stringify({ code: code })
        });

        voterToken = response.access_token;
        saveToken('voter', voterToken);
        currentUser = {
            code: code,
            name: response.name || 'Usuario',
            id: response.user_id || null,
            coefficient: response.coefficient || 1.00
        };
        isAdmin = false;
        
        showVoterScreen();
        notifications.show('Acceso a votaciones autorizado', 'success');
    } catch (error) {
        console.error('Error en acceso:', error);

        if (error.message.includes('401') || error.message.includes('not found') || error.message.includes('Invalid credentials')) {
            notifications.show('Código no encontrado o no registrado. Use "Registro" primero.', 'error');
        } else if (error.message.includes('403') || error.message.includes('asistencia primero')) {
        notifications.show('Debe registrar su asistencia antes de acceder a las votaciones.', 'info');
        } else if (error.message.includes('404') || error.message.includes('not found')) {
            notifications.show('Su código no está en el sistema o no ha registrado asistencia. Consulte con la administración.', 'error');
        } else if (error.message.includes('No hay participantes')) {
            notifications.show('El sistema aún no ha sido configurado. Consulte con el administrador de la asamblea.', 'error');
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
        notifications.show('Verificando credenciales...', 'info');
        
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
        notifications.show('Acceso de administrador autorizado', 'success');
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

// ================================
// MODALES AUXILIARES
// ================================

function showTestUserModal() {
    modals.show({
        title: '🧪 Usuario de Prueba',
        content: `
            <p><strong>Código:</strong> ${CODIGO_PRUEBA}</p>
            <p><strong>Tipo:</strong> Demostración</p>
            <p style="color: var(--gray-700); font-size: 0.9rem;">Este usuario no afecta estadísticas reales</p>
        `,
        actions: [
            {
                text: 'Ir a Votaciones de Prueba',
                class: 'btn-primary',
                handler: 'modals.hide(); showVoterScreen();'
            }
        ]
    });
}

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
        modals.show({
            title: 'Información del Apartamento',
            content: `
                <p style="margin-bottom: 1.5rem;">¿Este apartamento es suyo o tiene poder para votar por él?</p>
                <div style="display: flex; gap: 1rem; justify-content: center;">
                    <button class="btn btn-success" onclick="resolvePowerQuestion(false)" style="flex: 1;">
                        Soy propietario
                    </button>
                    <button class="btn btn-warning" onclick="resolvePowerQuestion(true)" style="flex: 1;">
                        Tengo poder
                    </button>
                </div>
            `,
            closable: false
        });
        
        window.resolvePowerQuestion = (isPower) => {
            modals.hide();
            delete window.resolvePowerQuestion;
            resolve(isPower);
        };
    });
}

// ================================
// PANTALLA DE VOTANTES
// ================================

async function showVoterScreen() {
    // Usar window.currentUser como fallback si currentUser es null
    const user = currentUser || window.currentUser;
    console.log('showVoterScreen - currentUser:', currentUser);
    console.log('showVoterScreen - window.currentUser:', window.currentUser);
    console.log('showVoterScreen - user final:', user);
    
    if (!user || !user.code) {
        console.error('No hay usuario válido');
        notifications.show('Error: Usuario no inicializado correctamente', 'error');
        showScreen('welcome-screen');
        return;
    }
    
    // Asegurar que currentUser esté sincronizado
    currentUser = user;
    showScreen('voter-screen');
    
    // Solo conectar WebSocket si NO es usuario de prueba
    if (user.code !== CODIGO_PRUEBA) {
        connectWebSocket();
    }
    
    // Usar 'user' en lugar de 'currentUser' para el resto
    document.getElementById('voter-code').textContent = user.code;
    document.getElementById('voter-name').textContent = `Bienvenido/a, ${user.name}`;
    
    // Mostrar coeficiente si está disponible
    if (currentUser.coefficient) {
        let coeffElement = document.getElementById('voter-coefficient');
        if (!coeffElement) {
            const userMeta = document.querySelector('.user-meta');
            if (userMeta) {  // ← Verificar que existe
                coeffElement = document.createElement('span');
                coeffElement.id = 'voter-coefficient';
                userMeta.appendChild(coeffElement);
                coeffElement.textContent = `Coeficiente: ${currentUser.coefficient}%`;
            }
        } else {
            coeffElement.textContent = `Coeficiente: ${currentUser.coefficient}%`;
        }
    }
    
    // Mostrar nombre del conjunto
    try {
        const conjuntoData = await apiCall('/participants/conjunto/nombre');
        if (conjuntoData && conjuntoData.nombre) {
            let conjuntoElement = document.getElementById('voter-conjunto');
            if (!conjuntoElement) {
                const userMeta = document.querySelector('.user-meta');
                if (userMeta) {  // ← Verificar que existe
                    conjuntoElement = document.createElement('span');
                    conjuntoElement.id = 'voter-conjunto';
                    userMeta.appendChild(conjuntoElement);
                }
            }
            if (conjuntoElement) {
                conjuntoElement.textContent = conjuntoData.nombre;
            }
        }
    } catch (error) {
        console.log('No se pudo cargar nombre del conjunto');
    }
    
    await loadVotingQuestions();
}

async function loadVotingQuestions() {
    const container = document.getElementById('voting-questions');
    
    try {
        // Para usuario de prueba
        if (currentUser && currentUser.code === CODIGO_PRUEBA) {
            const testQuestions = getSimulatedTestQuestions();
            renderVotingQuestions(testQuestions);
            return;
        }

        // CORRECCIÓN: Verificar que el usuario tenga token válido
        if (!voterToken) {
            container.innerHTML = `
                <div class="panel">
                    <p style="color: var(--danger-color); text-align: center;">Sesión expirada. Por favor, vuelva a ingresar.</p>
                </div>
            `;
            return;
        }

        if (isAdmin) {
            await apiCall('/voting/questions/check-expired', { method: 'POST' });
        }

        const questions = await apiCall('/voting/questions/active');
        const votedQuestions = await checkUserVotes();
        
        renderVotingQuestions(questions, votedQuestions);
    } catch (error) {
        console.error('Error loading voting questions:', error);
        container.innerHTML = `
            <div class="panel">
                <p style="color: var(--danger-color); text-align: center;">Error cargando votaciones: ${error.message}</p>
                <button class="btn btn-secondary" onclick="loadVotingQuestions()">Reintentar</button>
            </div>
        `;
    }
}

function renderVotingQuestions(questions, votedQuestions = new Set()) {
    const container = document.getElementById('voting-questions');
    
    if (questions.length === 0) {
        container.innerHTML = `
            <div class="panel">
                <div style="text-align: center; padding: 3rem; color: var(--gray-600);">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 1rem; opacity: 0.5;">
                        <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
                        <path d="M9 7V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path>
                    </svg>
                    <h3 style="margin-bottom: 0.5rem; color: var(--gray-700);">No hay votaciones activas</h3>
                    <p>Espere a que el administrador active nuevas votaciones</p>
                </div>
            </div>
        `;
        return;
    }

    // Ordenar preguntas: abiertas primero, luego cerradas
    const sortedQuestions = [...questions].sort((a, b) => {
        if (a.closed === b.closed) return 0;
        return a.closed ? 1 : -1;
    });

    let html = '';
    sortedQuestions.forEach(question => {
        const hasVoted = votedQuestions.has(question.id);
        
        if (hasVoted) {
            // Mostrar que ya votó
            html += VotingComponents.createVotedStatus(question, 'Registrado');
        } else if (question.closed) {
            // Votación cerrada
            html += `
                <div class="voting-card">
                    <div class="question-header">
                        <div class="question-title">${question.text}</div>
                    </div>
                    <div class="voted-status" style="background: linear-gradient(145deg, #fef2f2, #fecaca); border-color: var(--danger-color); color: var(--danger-dark);">
                        🔒 Esta votación ha sido cerrada
                    </div>
                </div>
            `;
        } else {
            // Votación activa
            if (question.type === 'yesno') {
                html += VotingComponents.createYesNoVoting(question);
            } else {
                html += VotingComponents.createMultipleVoting(question);
            }
        }
    });

    container.innerHTML = html;
}

function getSimulatedTestQuestions() {
    return [
        {
            id: 9991,
            text: "[PRUEBA] ¿Aprueba la propuesta de mejoras?",
            type: "yesno",
            closed: false,
            options: [{text: 'SÍ'}, {text: 'No'}]
        },
        {
            id: 9992, 
            text: "[PRUEBA] Elija el representante de la junta",
            type: "multiple",
            closed: false,
            allow_multiple: false,
            max_selections: 1,
            options: [
                {text: "Juan Pérez"}, 
                {text: "María García"}, 
                {text: "Carlos López"}
            ]
        },
        {
            id: 9993,
            text: "[PRUEBA] Seleccione mejoras prioritarias (máximo 2)",
            type: "multiple", 
            closed: false,
            allow_multiple: true,
            max_selections: 2,
            options: [
                {text: "Piscina"}, 
                {text: "Gimnasio"}, 
                {text: "Jardines"}, 
                {text: "Parqueaderos"}
            ]
        }
    ];
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
    if (currentUser && currentUser.code === CODIGO_PRUEBA) {
        notifications.show(`Voto de prueba registrado: ${answer}`, 'success');
        setTimeout(() => loadVotingQuestions(), 1000);
        return;
    }

    try {
        notifications.show('Registrando voto...', 'info');
        
        await apiCall('/voting/vote', {
            method: 'POST',
            body: JSON.stringify({
                question_id: questionId,
                answer: answer
            })
        });

        await loadVotingQuestions();
        notifications.show(`Voto registrado: ${answer}`, 'success');
    } catch (error) {
        if (error.message.includes('Ya has votado')) {
            notifications.show('Ya has votado en esta pregunta', 'error');
        } else {
            notifications.show(`Error: ${error.message}`, 'error');
        }
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
        
        // Actualizar contadores
        const nowSelected = container.querySelectorAll('.multiple-option.selected');
        const countDisplay = container.querySelector('.selected-count');
        if (countDisplay) {
            countDisplay.textContent = nowSelected.length;
        }
        
        // Actualizar números de selección
        nowSelected.forEach((option, index) => {
            const indicator = option.querySelector('.option-indicator');
            indicator.textContent = index + 1;
        });
        
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
        element.querySelector('.option-indicator').textContent = '✓';
        
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
        notifications.show(`Votos de prueba registrados: ${answers.join(', ')}`, 'success');
        setTimeout(() => loadVotingQuestions(), 1000);
        return;
    }

    try {
        notifications.show('Registrando votos...', 'info');
        
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
    await loadAdminData();
    
    // Solo actualizar display si ya existe el nombre
    try {
        const response = await apiCall('/participants/conjunto/nombre');
        if (response.nombre) {
            updateConjuntoDisplay(response.nombre);
        }
    } catch (error) {
        console.log('No se pudo cargar nombre del conjunto');
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
                
                updateConjuntoDisplay(nombre);
                modals.hide();
                delete window.saveConjuntoName;
                notifications.show('Nombre del conjunto guardado', 'success');
                resolve(true);
            } catch (error) {
                notifications.show(`Error: ${error.message}`, 'error');
            }
        };
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

    // Timer checkbox
    document.getElementById('enable-timer').addEventListener('change', (e) => {
        const timerConfig = document.getElementById('timer-config');
        timerConfig.style.display = e.target.checked ? 'block' : 'none';
    });
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
    } else {
        console.error(`Tab ${tabName} not found`);
        // Fallback: mostrar primera tab
        const firstTab = document.querySelector('.tab-content');
        const firstButton = document.querySelector('.tab-button');
        if (firstTab && firstButton) {
            firstTab.classList.add('active');
            firstButton.classList.add('active');
        }
    }
}

async function loadAdminData() {
    await Promise.all([
        loadAforoData(),
        loadActiveQuestions(),
        refreshConnectedUsers()
    ]);
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
    try {
        const questions = await apiCall('/voting/questions/active');
        renderActiveQuestions(questions);
    } catch (error) {
        console.error('Error loading questions:', error);
        document.getElementById('active-questions').innerHTML = 
            '<p style="color: var(--danger-color); padding: 1rem;">Error cargando preguntas activas</p>';
    }
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
                    <div style="padding: 0.8rem; border-bottom: 1px solid var(--gray-200); display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>${voter.code}</strong> - ${voter.name}
                            <span style="color: var(--primary-color); margin-left: 0.5rem;">${voter.coefficient}%</span>
                        </div>
                        <span style="background: ${voter.is_power ? 'var(--warning-color)' : 'var(--success-color)'}; color: white; padding: 0.2rem 0.5rem; border-radius: 12px; font-size: 0.8rem;">
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
            <div style="text-align: center; padding: 3rem; color: var(--gray-600);">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 1rem; opacity: 0.5;">
                    <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
                    <path d="M9 7V3a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path>
                </svg>
                <h3 style="margin-bottom: 0.5rem; color: var(--gray-700);">No hay votaciones creadas</h3>
                <p>Cree una nueva votación usando el formulario de arriba</p>
            </div>
        `;
        return;
    }

    container.innerHTML = questions.map(q => AdminComponents.createActiveVotingCard(q)).join('');
}

// ================================
// FUNCIONES DE ADMINISTRACIÓN
// ================================

async function checkParticipants() {
    try {
        notifications.show('Verificando participantes...', 'info');
        
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
            notifications.show(`✅ ${response.length} participantes verificados`, 'success');
        }
    } catch (error) {
        const statusCircle = document.getElementById('status-circle');
        const statusText = document.getElementById('status-text');
        
        statusCircle.className = 'status-circle error';
        statusText.textContent = 'Error al verificar';
        
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

function showParticipantsModal(title, participants) {
    const participantsPerPage = 25;
    let currentPage = 1;
    let filteredParticipants = [...participants];
    
    function renderPage() {
        const startIndex = (currentPage - 1) * participantsPerPage;
        const endIndex = startIndex + participantsPerPage;
        const pageParticipants = filteredParticipants.slice(startIndex, endIndex);
        const totalPages = Math.ceil(filteredParticipants.length / participantsPerPage);
        
        const paginationHTML = totalPages > 1 ? `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: 1rem; background: var(--gray-100); border-radius: 8px;">
                <button onclick="changePage(${currentPage - 1})" 
                        ${currentPage === 1 ? 'disabled' : ''} 
                        class="btn btn-secondary" style="padding: 0.5rem 1rem;">
                    ← Anterior
                </button>
                <span style="color: var(--gray-700); font-size: 0.9rem;">
                    Página ${currentPage} de ${totalPages} (${filteredParticipants.length} resultados)
                </span>
                <button onclick="changePage(${currentPage + 1})" 
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
                        <span style="font-weight: 600;">${p.code}</span>
                        <span style="overflow: hidden; text-overflow: ellipsis;">${p.name || 'Sin nombre'}</span>
                        <span style="color: var(--primary-color); font-weight: 500; text-align: right;">${p.coefficient || 0}%</span>
                        <button class="btn btn-info" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="showVoterManagementModal('${p.code}')">
                            👤 Gestionar
                        </button>
                    </div>
                `).join('')}
            </div>`;
        
        return `
            ${paginationHTML}
            ${participantsList}
        `;
    }
    
    modals.show({
        title: title,
        size: 'large',
        content: `
            <input type="text" id="participant-search" placeholder="Buscar por código o nombre..." 
                   style="width: 100%; padding: 0.8rem; margin-bottom: 1rem; border: 2px solid var(--gray-300); border-radius: 8px;"
                   oninput="filterParticipants(this.value)">
            <div id="participants-content">
                ${renderPage()}
            </div>
        `,
        actions: [
            {
                text: 'Cerrar',
                class: 'btn-secondary',
                handler: 'modals.hide()'
            }
        ]
    });
    
    // Funciones locales del modal
    window.changePage = (newPage) => {
        const totalPages = Math.ceil(filteredParticipants.length / participantsPerPage);
        if (newPage >= 1 && newPage <= totalPages) {
            currentPage = newPage;
            document.getElementById('participants-content').innerHTML = renderPage();
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
        document.getElementById('participants-content').innerHTML = renderPage();
    };
    
    // Limpiar funciones globales al cerrar el modal
    const originalHide = modals.hide.bind(modals);
    modals.hide = () => {
        delete window.changePage;
        delete window.filterParticipants;
        modals.hide = originalHide;
        originalHide();
    };
}

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
        
        notifications.show(`Archivo cargado: ${result.inserted} participantes`, 'success');
        
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

        // Verificar tiempo límite
        const enableTimer = document.getElementById('enable-timer').checked;
        if (enableTimer) {
            const timeLimit = parseInt(document.getElementById('time-limit-minutes').value);
            if (timeLimit && timeLimit > 0) {
                questionData.time_limit_minutes = timeLimit;
            }
        }
        
        if (maxSelections > options.length) {
            notifications.show('El máximo de selecciones no puede ser mayor al número de opciones', 'error');
            return;
        }
    }

    try {
        notifications.show('Creando votación...', 'info');
        
        await apiCall('/voting/questions', {
            method: 'POST',
            body: JSON.stringify(questionData)
        });

        // Limpiar formulario
        document.getElementById('question-text').value = '';
        document.getElementById('options-list').innerHTML = '';
        document.getElementById('max-selections').value = '1';

        notifications.show('Votación creada y activada', 'success');
        await loadActiveQuestions();
        
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
        
        let contentHTML = `
            <div style="background: var(--gray-50); padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem;">
                <p><strong>Pregunta:</strong> ${results.question_text}</p>
                <p><strong>Participaron:</strong> ${results.total_participants} personas</p>
                <p><strong>Coeficiente total:</strong> ${results.total_participant_coefficient}%</p>
            </div>
            
            <div style="max-height: 300px; overflow-y: auto;">
                ${results.results && results.results.length > 0 ? 
                    results.results.map(result => `
                        <div style="display: flex; align-items: center; padding: 0.8rem; margin: 0.5rem 0; background: white; border-radius: 8px; border: 1px solid var(--gray-300);">
                            <span style="flex: 0 0 120px; font-weight: 600;">${result.answer}:</span>
                            <div style="flex: 1; margin: 0 1rem;">
                                <div style="background: var(--gray-200); height: 8px; border-radius: 4px; overflow: hidden;">
                                    <div style="height: 100%; background: linear-gradient(90deg, var(--primary-color), var(--success-color)); width: ${result.percentage}%; transition: width 0.5s ease;"></div>
                                </div>
                            </div>
                            <span style="flex: 0 0 80px; text-align: right; font-weight: 600;">${result.votes} votos (${result.percentage.toFixed(2)}%)</span>
                        </div>
                    `).join('') : 
                    '<p style="text-align: center; color: var(--gray-600);">Sin votos registrados</p>'
                }
            </div>
        `;
        
        modals.show({
            title: 'Resultados Detallados',
            content: contentHTML,
            size: 'large',
            actions: [
                {
                    text: 'Cerrar',
                    class: 'btn-secondary',
                    handler: 'modals.hide()'
                }
            ]
        });
        
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
    }
}

async function deleteVoting(questionId) {
    const confirmed = await modals.confirm(
        '¿Eliminar esta encuesta? Se borrarán también todos los votos.',
        'Confirmar eliminación'
    );
    
    if (!confirmed) return;
    
    try {
        await apiCall(`/voting/questions/${questionId}`, { method: 'DELETE' });
        await loadActiveQuestions();
        notifications.show('Encuesta eliminada', 'success');
    } catch (error) {
        notifications.show(`Error: ${error.message}`, 'error');
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
        notifications.show('Extendiendo tiempo...', 'info');
        
        await apiCall(`/voting/questions/${questionId}/extend-time`, {
            method: 'PUT',
            body: JSON.stringify({ extra_minutes: minutes })
        });
        
        modals.hide();
        notifications.show(`⏰ Tiempo extendido por ${minutes} minutos`, 'success');
        
    } catch (error) {
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
        notifications.show('Enviando mensaje...', 'info');
        
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
            notifications.show('Guardando cambios...', 'info');
            
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

function showDeleteCodeModal() {
    modals.show({
        title: '🚫 Eliminar Código',
        content: `
            <p style="color: var(--gray-700); margin-bottom: 1rem; text-align: center;">
                Esta acción eliminará el registro de asistencia del código especificado.
            </p>
            
            <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">Código a eliminar:</label>
            <input type="text" id="delete-code-input" class="modal-input" placeholder="1-201" 
                   style="text-transform: uppercase;">
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
                handler: 'confirmDeleteCode()'
            }
        ]
    });
    
    window.confirmDeleteCode = async () => {
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
            delete window.confirmDeleteCode;
            await loadAforoData();
            notifications.show(`Código ${code} eliminado correctamente`, 'success');
            
        } catch (error) {
            notifications.show(`Error: ${error.message}`, 'error');
        }
    };
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
        notifications.show('Generando archivos...', 'info');
        
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
        notifications.show('Realizando reset completo...', 'info');
        
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
            if (el) el.textContent = '';
        });

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

document.addEventListener('DOMContentLoaded', async () => {
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

function setupMainEventListeners() {
    // Botón de logout
    document.getElementById('logout-button').addEventListener('click', logout);
    
    // Botones de la pantalla principal
    document.getElementById('register-btn').addEventListener('click', registerAttendance);
    document.getElementById('voting-btn').addEventListener('click', accessVoting);
    document.getElementById('admin-btn').addEventListener('click', showAdminLogin);
    
    // Input de código con Enter
    document.getElementById('access-code').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            accessVoting();
        }
    });
    
    // Prevenir envío de formularios
    document.addEventListener('submit', (e) => {
        e.preventDefault();
    });
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

// Sistema de cronómetros en tiempo real
function startTimerUpdates() {
    setInterval(() => {
        document.querySelectorAll('.question-timer').forEach(timer => {
            const remaining = parseInt(timer.getAttribute('data-remaining'));
            if (remaining > 0) {
                const newRemaining = remaining - 1;
                timer.setAttribute('data-remaining', newRemaining);
                const minutes = Math.floor(newRemaining / 60);
                const seconds = newRemaining % 60;
                timer.textContent = `⏰ ${minutes}:${String(seconds).padStart(2, '0')} restantes`;
                
                // Cambiar color cuando quedan menos de 2 minutos
                if (newRemaining < 120) {
                    timer.style.background = 'linear-gradient(135deg, var(--danger-color), var(--danger-dark))';
                    timer.style.animation = 'pulse 2s infinite';
                }
            } else {
                timer.textContent = '⏰ Tiempo agotado';
                timer.style.background = 'linear-gradient(135deg, var(--danger-color), var(--danger-dark))';
            }
        });
    }, 1000);
}

// Iniciar cronómetros cuando se carga la página de votante
document.addEventListener('DOMContentLoaded', () => {
    startTimerUpdates();
});

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
        if (isAdmin && document.querySelector('.tab-button[data-tab="monitoreo"].active')) {
            await refreshServerStatus();
        }
    }, 5000); // Actualizar cada 5 segundos
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