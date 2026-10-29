(function () {
  "use strict";

  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  var total = slides.length;
  var current = 0;

  var prevBtn = document.getElementById("prevBtn");
  var nextBtn = document.getElementById("nextBtn");
  var dotsWrap = document.getElementById("dots");
  var progressBar = document.getElementById("progressBar");
  var progressEl = document.getElementById("progress");
  var currentLbl = document.getElementById("currentSlide");
  var totalLbl = document.getElementById("totalSlides");
  var fsBtn = document.getElementById("fullscreenBtn");

  totalLbl.textContent = String(total);

  var dots = [];
  slides.forEach(function (slide, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "Ir a la diapositiva " + (i + 1));
    b.addEventListener("click", function () {
      goTo(i);
    });
    dotsWrap.appendChild(b);
    dots.push(b);
  });

  function render() {
    slides.forEach(function (slide, i) {
      var active = i === current;
      slide.classList.toggle("is-active", active);
      slide.setAttribute("aria-hidden", active ? "false" : "true");
    });

    dots.forEach(function (dot, i) {
      if (i === current) {
        dot.setAttribute("aria-current", "true");
      } else {
        dot.removeAttribute("aria-current");
      }
    });

    currentLbl.textContent = String(current + 1);

    var pct = Math.round(((current + 1) / total) * 100);
    progressBar.style.width = pct + "%";
    progressEl.setAttribute("aria-valuenow", String(pct));

    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === total - 1;

    slides[current].scrollTop = 0;
  }

  function goTo(index) {
    if (index < 0 || index >= total || index === current) return;
    current = index;
    render();
  }

  function next() {
    goTo(Math.min(current + 1, total - 1));
  }
  function prev() {
    goTo(Math.max(current - 1, 0));
  }

  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);

  document.addEventListener("keydown", function (event) {
    var tag = (event.target && event.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    switch (event.key) {
      case "ArrowRight":
      case "PageDown":
        event.preventDefault();
        next();
        break;
      case "ArrowLeft":
      case "PageUp":
        event.preventDefault();
        prev();
        break;
      case "Home":
        event.preventDefault();
        goTo(0);
        break;
      case "End":
        event.preventDefault();
        goTo(total - 1);
        break;
      case "f":
      case "F":
        event.preventDefault();
        toggleFullscreen();
        break;
      case "Escape":
        break;
      default:
        break;
    }
  });

  function isFullscreen() {
    return Boolean(
      document.fullscreenElement || document.webkitFullscreenElement,
    );
  }

  function toggleFullscreen() {
    if (!isFullscreen()) {
      var el = document.documentElement;
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        var result = req.call(el);
        if (result && typeof result.catch === "function") {
          result.catch(function () {});
        }
      }
    } else {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        var res = exit.call(document);
        if (res && typeof res.catch === "function") {
          res.catch(function () {});
        }
      }
    }
  }

  function syncFullscreenButton() {
    var active = isFullscreen();
    fsBtn.setAttribute("aria-pressed", active ? "true" : "false");
    var label = fsBtn.querySelector(".btn__label");
    if (label) {
      label.textContent = active
        ? "Salir de pantalla completa"
        : "Pantalla completa";
    }
    fsBtn.title =
      (active ? "Salir de pantalla completa" : "Pantalla completa") + " (F)";
  }

  fsBtn.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncFullscreenButton);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButton);

  var NODE_INFO = {
    "client-web": {
      tag: "Clientes",
      title: "Web React",
      desc: "Aplicación de tienda para navegador. Consume la API a través del gateway y nunca habla directamente con la base de datos ni con el proveedor de pagos.",
      items: [
        "Sesión basada en tokens de corta duración.",
        "Reutiliza la misma Idempotency-Key al reintentar un checkout.",
        "Consulta el estado de la orden por polling controlado.",
      ],
    },
    "client-mobile": {
      tag: "Clientes",
      title: "App móvil (React Native)",
      desc: "Cliente nativo multiplataforma que comparte el mismo contrato de API que la web.",
      items: [
        "Mismos endpoints versionados: /api/v1.",
        "Cola local de reintentos para operaciones de checkout.",
        "Notificaciones push del cambio de estado de la orden.",
      ],
    },
    "client-admin": {
      tag: "Clientes",
      title: "Portal administrativo",
      desc: "Interfaz interna para gestión de catálogo, stock, pedidos y usuarios.",
      items: [
        "Autorización por recurso, no solo por rol.",
        "Auditoría de cada acción administrativa.",
        "Acceso restringido por WAF y lista de IP permitidas.",
      ],
    },
    gateway: {
      tag: "Entrada",
      title: "API Gateway / BFF",
      desc: "Punto único de entrada. Termina TLS, autentica, aplica límites de tasa y compone respuestas para cada tipo de cliente.",
      items: [
        "HTTPS obligatorio con TLS 1.3.",
        "Autenticación y validación de tokens antes de tocar el backend.",
        "Rate limiting por usuario y por IP.",
        "Traduce errores internos a códigos HTTP estables.",
      ],
    },
    backend: {
      tag: "Backend",
      title: "Monolito modular (Node.js / NestJS)",
      desc: "Un único despliegue con módulos de dominio con límites explícitos. Las transacciones entre módulos son locales, lo que elimina la necesidad de sagas desde el inicio.",
      items: [
        "Cada módulo expone una interfaz interna y no accede a las tablas de otro.",
        "La transacción de checkout abarca inventario, órdenes y outbox.",
        "Preparado para extraerse a servicio propio si un módulo lo justifica.",
      ],
    },
    "mod-catalogo": {
      tag: "Módulo",
      title: "Catálogo",
      desc: "Productos, variantes, precios y categorías. Es el módulo con más lecturas.",
      items: [
        "Lecturas servidas desde caché en Redis con invalidación por evento.",
        "Imágenes almacenadas en S3 y servidas por CDN.",
      ],
    },
    "mod-inventario": {
      tag: "Módulo",
      title: "Inventario",
      desc: "Gobierna el stock disponible y las reservas temporales asociadas a una orden.",
      items: [
        "La reserva se crea dentro de la transacción SQL, nunca en caché.",
        "Control de concurrencia con bloqueo a nivel de fila.",
        "Restricciones en base de datos para impedir stock negativo.",
        "Las reservas expiran y se liberan mediante un job programado.",
      ],
    },
    "mod-carrito": {
      tag: "Módulo",
      title: "Carrito",
      desc: "Estado efímero de la compra antes de convertirse en orden.",
      items: [
        "Puede vivir en Redis: no requiere durabilidad absoluta.",
        "Valida precios y disponibilidad contra catálogo e inventario.",
      ],
    },
    "mod-ordenes": {
      tag: "Módulo",
      title: "Órdenes",
      desc: "Ciclo de vida de la orden: PENDING_PAYMENT, CONFIRMED, PAYMENT_FAILED, CANCELLED_OR_EXPIRED.",
      items: [
        "Clave de idempotencia única por intento de creación.",
        "Nunca cambia de estado por un timeout del cliente.",
        "Solo un evento verificado del proveedor confirma el pago.",
      ],
    },
    "mod-pagos": {
      tag: "Módulo",
      title: "Pagos",
      desc: "Orquesta la comunicación con el proveedor externo fuera de la transacción SQL.",
      items: [
        "Nunca se llama al proveedor dentro de una transacción abierta.",
        "Reintentos con backoff exponencial y circuit breaker.",
        "Verificación criptográfica de la firma de cada webhook.",
        "Deduplicación por identificador de evento del proveedor.",
      ],
    },
    "mod-usuarios": {
      tag: "Módulo",
      title: "Usuarios",
      desc: "Identidad, credenciales, roles y permisos.",
      items: [
        "Contraseñas con hash lento y sal única.",
        "Autorización evaluada por recurso, no solo por rol global.",
      ],
    },
    "mod-notificaciones": {
      tag: "Módulo",
      title: "Notificaciones",
      desc: "Correo, push y avisos operativos disparados por eventos de dominio.",
      items: [
        "Consumo asíncrono: un fallo de envío no bloquea el checkout.",
        "Reintentos con dead-letter queue para los envíos fallidos.",
      ],
    },
    "mod-auditoria": {
      tag: "Módulo",
      title: "Auditoría",
      desc: "Registro inmutable de acciones sensibles y cambios de estado.",
      items: [
        "Correlation ID en cada entrada para reconstruir trazas.",
        "Solo inserción: no se actualiza ni se borra.",
      ],
    },
    outbox: {
      tag: "Patrón",
      title: "Transactional Outbox",
      desc: "Resuelve el problema del doble escritura: el evento se guarda en la misma transacción que el cambio de negocio y se publica después.",
      items: [
        "Si la transacción hace commit, el evento existe garantizado.",
        "Un worker lee la tabla outbox y publica en RabbitMQ.",
        "Entrega al menos una vez: los consumidores deben ser idempotentes.",
        "Permite reconciliar eventos que fallaron al publicarse.",
      ],
    },
    "db-postgres": {
      tag: "Datos",
      title: "PostgreSQL",
      desc: "Fuente de verdad para usuarios, órdenes, inventario, reservas e idempotencia.",
      items: [
        "Transacciones ACID y restricciones de integridad declarativas.",
        "Índice único sobre la clave de idempotencia.",
        "Replicación Multi-AZ y backups con recuperación a un punto en el tiempo.",
      ],
    },
    "db-redis": {
      tag: "Datos",
      title: "Redis",
      desc: "Caché de lecturas y almacén de sesiones. Nunca es la garantía de inventario.",
      items: [
        "Si Redis se pierde, el sistema sigue siendo correcto.",
        "Invalidación por evento cuando el catálogo cambia.",
      ],
    },
    "db-rabbit": {
      tag: "Datos",
      title: "RabbitMQ",
      desc: "Broker de eventos asíncronos con colas de trabajo y dead-letter queue.",
      items: [
        "Desacopla pagos, notificaciones y proyecciones de lectura.",
        "Los mensajes fallidos van a una DLQ para inspección manual.",
        "Publicación fiable garantizada por el patrón Outbox.",
      ],
    },
    "db-s3": {
      tag: "Datos",
      title: "Amazon S3 + CDN",
      desc: "Almacenamiento de imágenes de producto y su distribución global.",
      items: [
        "El backend solo guarda la referencia, nunca los binarios.",
        "La CDN absorbe la mayor parte del tráfico de lectura.",
      ],
    },
    "db-pagos": {
      tag: "Externo",
      title: "Proveedor de pagos",
      desc: "Servicio externo que ejecuta el cobro y notifica el resultado mediante webhooks firmados.",
      items: [
        "Es la única autoridad sobre si un pago se aprobó.",
        "Los webhooks pueden llegar duplicados o fuera de orden.",
        "Se verifica la firma antes de procesar cualquier notificación.",
      ],
    },
    "db-obs": {
      tag: "Operación",
      title: "Observabilidad",
      desc: "Logs estructurados, métricas, trazas distribuidas y alertas operativas.",
      items: [
        "Correlation ID propagado desde el gateway hasta la base de datos.",
        "Alertas sobre latencia p95, tasa de error y cola de outbox pendiente.",
        "Trazas distribuidas vía OpenTelemetry.",
      ],
    },
  };

  var panel = document.getElementById("nodePanel");
  var nodes = Array.prototype.slice.call(document.querySelectorAll(".node"));
  var resetBtn = document.getElementById("resetDiagram");
  var selectedNode = null;

  var PANEL_HINT_HTML =
    '<p class="panel__hint">Selecciona cualquier bloque del diagrama con clic o con ' +
    "<kbd>Tab</kbd> + <kbd>Enter</kbd> para ver su descripción.</p>";

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showNodeInfo(key) {
    var info = NODE_INFO[key];
    if (!info || !panel) return;

    var html = "";
    html += '<span class="panel__tag">' + escapeHtml(info.tag) + "</span>";
    html += '<h3 class="panel__title">' + escapeHtml(info.title) + "</h3>";
    html += "<p>" + escapeHtml(info.desc) + "</p>";

    if (info.items && info.items.length) {
      html += '<ul class="panel__list">';
      info.items.forEach(function (item) {
        html += "<li>" + escapeHtml(item) + "</li>";
      });
      html += "</ul>";
    }

    panel.innerHTML = html;
  }

  function selectNode(node) {
    if (selectedNode === node) return;
    if (selectedNode) selectedNode.classList.remove("is-selected");
    selectedNode = node;
    if (node) {
      node.classList.add("is-selected");
      showNodeInfo(node.getAttribute("data-node"));
    }
  }

  function clearSelection() {
    if (selectedNode) selectedNode.classList.remove("is-selected");
    selectedNode = null;
    if (panel) panel.innerHTML = PANEL_HINT_HTML;
  }

  nodes.forEach(function (node) {
    node.addEventListener("click", function () {
      selectNode(node);
    });

    node.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNode(node);
      }
    });

    node.addEventListener("focus", function () {
      node.classList.add("is-selected");
    });

    node.addEventListener("blur", function () {
      if (node !== selectedNode) {
        node.classList.remove("is-selected");
      }
    });
  });

  if (resetBtn) {
    resetBtn.addEventListener("click", clearSelection);
  }

  render();
  syncFullscreenButton();
  if (panel) panel.innerHTML = PANEL_HINT_HTML;
})();
