## 1. Revisión y optimización de código

### 1.1 Backend / API

#### Problemas identificados

1. **Inyección SQL (Seguridad – Crítica):** El uso de template literals (`${userId}`, `${order.id}`) concatena directamente la entrada del usuario en la consulta. Un atacante puede inyectar SQL malicioso. **Solución:** Usar consultas parametrizadas (`$1`, `$2`).
2. **Fuga de información y sobre-consulta (Seguridad / Diseño de API):** `SELECT *` devuelve todas las columnas, incluyendo posibles datos sensibles o campos internos. Además, no se valida que el `userId` autenticado coincida con el solicitado (IDOR – Broken Access Control). **Solución:** Seleccionar columnas explícitas y aplicar autorización a nivel de objeto.
3. **Problema N+1 (Rendimiento – Crítico):** Se ejecuta una consulta por cada orden para obtener sus ítems. Con 100 órdenes, son 101 viajes a la base de datos. **Solución:** Usar un `JOIN` o una consulta `IN` para traer todos los ítems en una sola consulta, o usar `JSON_AGG` en PostgreSQL.
4. **Falta de validación de entrada (Seguridad / Calidad):** No se valida que `userId` sea un UUID/entero válido, ni que exista. Un valor malformado puede causar errores 500 o comportamientos inesperados. **Solución:** Validar con una librería como Zod o `express-validator`.
5. **Manejo de errores ausente (Mantenibilidad / Resiliencia):** No hay `try/catch`; cualquier fallo en la base de datos resulta en un error no controlado y una posible caída del proceso. **Solución:** Envolver en `try/catch` y devolver códigos HTTP adecuados (500, 400, 404).
6. **Falta de paginación (Rendimiento / Diseño de API):** Si el usuario tiene miles de órdenes, la respuesta será enorme y lenta. **Solución:** Implementar `LIMIT`/`OFFSET` o paginación por cursor.
7. **Acoplamiento directo a la base de datos (Mantenibilidad / Testabilidad):** El controlador llama directamente a `db.query`, dificultando pruebas unitarias y el cambio de fuente de datos. **Solución:** Usar el patrón **Repository** para abstraer el acceso a datos.
8. **Respuesta inconsistente (Diseño de API):** Se devuelve `orders.rows` que es un array, pero no se incluye metadatos como total o paginación. **Solución:** Devolver un objeto `{ data: [...], meta: { total, page } }`.
9. **Falta de índices (Rendimiento):** Sin índice en `orders.user_id` y `order_items.order_id`, las consultas harán escaneos completos de tabla.

#### Versión mejorada (pseudocódigo con patrón Repository + consulta optimizada)

```typescript
// order.repository.ts
class OrderRepository {
  async findByUserId(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const query = `
      SELECT o.id, o.status, o.total, o.created_at,
             COALESCE(
               JSON_AGG(
                 JSON_BUILD_OBJECT(
                   'id', oi.id,
                   'sku', oi.sku,
                   'quantity', oi.quantity,
                   'unitPrice', oi.unit_price
                 )
               ) FILTER (WHERE oi.id IS NOT NULL), '[]'
             ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3;
    `;
    return db.query(query, [userId, limit, offset]); // Parámetros seguros
  }
}

// order.controller.ts
app.get("/api/orders", authenticate, async (req, res) => {
  try {
    const { userId } = req.query;
    // Validación y autorización: el usuario autenticado solo puede ver sus propias órdenes
    if (req.user.id !== userId && !req.user.isAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const orders = await orderRepository.findByUserId(userId, page, limit);
    res.status(200).json({ data: orders.rows, meta: { page, limit } });
  } catch (error) {
    logger.error(
      { err: error, userId: req.query.userId },
      "Error fetching orders",
    );
    res.status(500).json({ error: "Internal server error" });
  }
});
```

#### Índices recomendados

- `CREATE INDEX idx_orders_user_id_created_at ON orders(user_id, created_at DESC);` – Acelera la búsqueda por usuario y el ordenamiento.
- `CREATE INDEX idx_order_items_order_id ON order_items(order_id);` – Acelera el `JOIN`.
- Si se filtra por estado: `CREATE INDEX idx_orders_user_status ON orders(user_id, status);`

---

### 1.2 Frontend / React

#### Problemas identificados

1. **Ejecución en cada render (Rendimiento – Crítico):** La llamada a `api.get` se ejecuta en el cuerpo del componente, no dentro de `useEffect`. Esto provoca una petición en cada render, incluyendo el bucle infinito causado por `setProducts`.
2. **Mutación directa del estado (Mantenibilidad – Crítico):** `products.push(...)` muta el array de estado directamente. React no detecta el cambio y no re-renderiza correctamente. **Solución:** Usar `setProducts(prev => [...prev, ...response.data])` o reemplazar el array.
3. **Falta de `useEffect` y dependencias (Correctitud):** El código parece tener un `useEffect` mal formado (el cierre de llaves es incorrecto). La lógica de fetching debe estar en `useEffect` con un array de dependencias controlado.
4. **Sin debounce (Rendimiento / UX):** Cada tecla dispara una petición. Escribir "react" genera 5 peticiones. **Solución:** Implementar debounce (ej. 300ms).
5. **Sin cancelación de peticiones (Correctitud / Rendimiento):** Las respuestas pueden llegar fuera de orden (la búsqueda de "rea" llega después de "react"). **Solución:** Usar `AbortController` para cancelar peticiones previas.
6. **`key={index}` (Mantenibilidad / Rendimiento):** Usar el índice como key es un antipatrón; si el orden cambia, React reutiliza mal los componentes. **Solución:** Usar `p.id` como key.
7. **Manejo de errores y loading ausente (UX):** No se muestra ningún indicador de carga ni mensaje de error.
8. **`console.log` en producción (Calidad):** Es una fuga de información y no es una acción útil.
9. **Falta de accesibilidad (UX):** El input no tiene `aria-label` ni está asociado a un label.

#### Cómo evitar solicitudes excesivas

- **Debounce:** Retrasar la ejecución de la petición hasta que el usuario deje de escribir por un tiempo determinado (ej. 300–500 ms). Se puede implementar con un `setTimeout` dentro de un `useEffect` o con una librería como `lodash.debounce` memoizada con `useMemo` para no recrearla en cada render.

#### Manejo de respuestas fuera de orden, loading, error y cancelación

- **Fuera de orden:** Al cancelar la petición anterior con `AbortController` cuando el término de búsqueda cambia, se evita que una respuesta obsoleta actualice el estado.
- **Loading:** Estado booleano `isLoading` que se activa antes de la petición y se desactiva en `finally`.
- **Error:** Estado `error` que se establece en el `catch` (ignorando errores de cancelación).
- **Cancelación:** En el cleanup del `useEffect`, llamar a `controller.abort()`.

#### Código corregido (con hook personalizado)

```tsx
import { useState, useEffect, useMemo } from "react";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function ProductList({ api }) {
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedSearch = useDebounce(search, 400);

  useEffect(() => {
    const controller = new AbortController();
    const fetchProducts = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await api.get(
          `/products?search=${encodeURIComponent(debouncedSearch)}`,
          { signal: controller.signal },
        );
        setProducts(response.data);
      } catch (err: any) {
        if (err.name !== "AbortError" && err.name !== "CanceledError") {
          setError("Error al cargar productos");
        }
      } finally {
        setIsLoading(false);
      }
    };

    fetchProducts();
    return () => controller.abort(); // Cancela peticiones obsoletas
  }, [debouncedSearch, api]);

  const handleProductClick = (product) => {
    // Acción real, no console.log
    // analytics.track('product_click', product.id);
  };

  if (error) return <div role="alert">{error}</div>;

  return (
    <div>
      <label htmlFor="product-search">Buscar productos</label>
      <input
        id="product-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Buscar productos"
      />
      {isLoading && <div aria-live="polite">Cargando...</div>}
      <ul>
        {products.map((p) => (
          <Product key={p.id} data={p} onClick={() => handleProductClick(p)} />
        ))}
      </ul>
    </div>
  );
}
```

---

### 1.3 SQL / datos

#### Problemas de exactitud y rendimiento

1. **Función sobre columna indexada (Rendimiento – Crítico):** `DATE(o.created_at) = '2026-10-01'` impide que el motor use un índice sobre `created_at`, forzando un escaneo completo de la tabla. La consulta no es **sargable**.
2. **Pérdida de clientes sin órdenes (Exactitud):** Al usar `JOIN` (INNER JOIN) entre `customers` y `orders`, se excluyen los clientes que no tienen órdenes en ese día. Si el objetivo es listar clientes con sus órdenes (o cero), debe usarse `LEFT JOIN`.
3. **Agrupación por nombre (Exactitud):** `GROUP BY c.name` puede agrupar clientes diferentes que compartan el mismo nombre. Debe agruparse por `c.id` (y seleccionar `c.name`).
4. **Desbordamiento de `SUM` (Exactitud):** `SUM` de `quantity * unit_price` puede desbordar si los valores son grandes; en PostgreSQL, usar `SUM(...)::numeric` o `COALESCE`.
5. **Uso de `COUNT(o.id)` (Exactitud):** Si se usa `LEFT JOIN`, `COUNT(o.id)` contará 0 para clientes sin órdenes, lo cual es correcto. Pero si se usa `INNER JOIN`, no aparecerán.

#### Consulta reescrita (filtro sargable)

```sql
SELECT
  c.id,
  c.name,
  COUNT(o.id) AS orders,
  COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS revenue
FROM customers c
LEFT JOIN orders o
  ON o.customer_id = c.id
  AND o.created_at >= '2026-10-01 00:00:00'
  AND o.created_at <  '2026-10-02 00:00:00'
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY c.id, c.name
ORDER BY revenue DESC;
```

**¿Por qué es mejor?**

- El rango `>=` y `<` permite usar un índice B-tree sobre `created_at`.
- `LEFT JOIN` conserva a todos los clientes.
- Se agrupa por `c.id` para evitar colisiones de nombres.

#### Índices recomendados

- `CREATE INDEX idx_orders_created_at_customer ON orders(created_at, customer_id);` – Para el filtro de fecha y el join.
- `CREATE INDEX idx_order_items_order_id ON order_items(order_id);` – Para el join con ítems.
- `CREATE INDEX idx_customers_id ON customers(id);` – Ya suele ser PK, pero se menciona por completitud.

#### Estrategia para cientos de millones de registros

1. **Particionamiento por rango de fechas:** Particionar `orders` por mes o por día (ej. `PARTITION BY RANGE (created_at)`). Las consultas por fecha solo escanean la partición relevante.
2. **Índices BRIN:** Para `created_at` en tablas muy grandes y con datos ordenados cronológicamente, un índice BRIN es mucho más pequeño y eficiente que un B-tree.
3. **Vistas materializadas:** Para reportes de ventas diarias, mantener una vista materializada agregada por día y cliente, refrescada periódicamente.
4. **Archivado en frío:** Mover órdenes antiguas a un almacenamiento histórico (ej. S3 + Athena) y mantener en la base transaccional solo los últimos meses.
5. **Connection pooling y réplicas de lectura:** Para consultas analíticas, usar réplicas de solo lectura.

---

## 2. Caso de arquitectura

### 13. Arquitectura de alto nivel

Se propone una **arquitectura monolito modular** inicialmente, con módulos bien delimitados (Bounded Contexts de DDD) que pueden extraerse a servicios si es necesario. Esto evita la complejidad prematura de microservicios.

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTES                              │
│   Web (React)          App Móvil (React Native)   Portal Admin│
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼────────────────────────────────┐
│                    API GATEWAY / BFF                         │
│   (Autenticación, Rate Limiting, Enrutamiento, CORS)         │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│              MONOLITO MODULAR (Node.js/NestJS)               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │ Catálogo │ │Inventario│ │ Carrito  │ │   Órdenes    │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │  Pagos   │ │Notificac.│ │ Usuarios │ │  Auditoría   │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │
└───────┬──────────────┬──────────────┬───────────────────────┘
        │              │              │
┌───────▼──────┐ ┌─────▼──────┐ ┌────▼─────────┐
│  PostgreSQL  │ │   Redis    │ │  RabbitMQ /  │
│ (Transacc.)  │ │  (Caché,   │ │   Kafka      │
│  + Outbox    │ │  Sesiones, │ │  (Eventos)   │
│              │ │  Reservas) │ │              │
└──────────────┘ └────────────┘ └──────────────┘
        │
┌───────▼────────────────────────────────────────────────────┐
│              ALMACENAMIENTO DE OBJETOS (S3)                │
│                   (Imágenes de productos)                  │
└────────────────────────────────────────────────────────────┘
```

**Componentes clave:**

- **API Gateway:** Punto único de entrada, autenticación JWT, rate limiting.
- **Monolito modular:** Un solo despliegue pero con módulos desacoplados por interfaces. Facilita la extracción futura.
- **PostgreSQL:** Base de datos transaccional con **Transactional Outbox** para garantizar entrega de eventos.
- **Redis:** Caché de catálogo, sesiones y **reservas temporales de inventario** (TTL).
- **RabbitMQ/Kafka:** Bus de eventos para notificaciones, pagos y sincronización asíncrona.
- **S3:** Almacenamiento de imágenes con CDN (CloudFront).
- **Observabilidad:** OpenTelemetry + Prometheus + Grafana + Loki.

### 14. Flujo completo desde "Pagar" hasta orden confirmada

1. **Usuario hace clic en "Pagar":** El frontend envía `POST /api/v1/orders` con el carrito y un `Idempotency-Key` (UUID v4 generado por el cliente).
2. **Backend (Órdenes):**
   - Valida la idempotencia: consulta `idempotency_keys`. Si la clave ya existe y la orden fue creada, devuelve la respuesta original (200).
   - Inicia una transacción de base de datos.
   - **Reserva de inventario:** Para cada ítem, ejecuta `SELECT ... FOR UPDATE` sobre `inventory` y verifica stock. Si hay suficiente, descuenta o marca como reservado con un `reservation_id` y `expires_at` (ej. 15 min). Si no, hace rollback y devuelve 409 Conflict.
   - Crea la orden en estado `PENDING_PAYMENT`.
   - Guarda un evento en la tabla `outbox` (ej. `OrderCreated`).
   - Guarda la clave de idempotencia con la respuesta (201).
   - **Commit** de la transacción.
3. **Worker de Outbox:** Lee el evento `OrderCreated` y publica en RabbitMQ. Un consumidor de **Pagos** lo recibe.
4. **Módulo de Pagos:** Llama al proveedor externo (Stripe, PayPal) de forma **asíncrona** (sin mantener transacción de BD abierta). Envía la solicitud de cobro. El proveedor responde (puede tardar). Si la respuesta es síncrona, actualiza la orden a `PAID`; si es asíncrona, espera el webhook.
5. **Webhook del proveedor:** El proveedor envía `POST /webhooks/payment` con la confirmación.
   - El backend **verifica la firma** del webhook.
   - Aplica **idempotencia** (guarda el `event_id` del webhook para no procesarlo dos veces).
   - Actualiza la orden a `CONFIRMED` (o `PAYMENT_FAILED`).
   - Publica evento `OrderConfirmed` en el outbox.
6. **Notificaciones:** Un consumidor de `OrderConfirmed` envía email/SMS al cliente y actualiza el estado en la app (vía WebSocket o push).
7. **Respuesta al cliente:** El frontend recibe la confirmación (por polling, WebSocket o la respuesta del webhook si es síncrono).

### 15. Componentes principales

| Componente         | Tecnología / Patrón                        | Responsabilidad                             |
| ------------------ | ------------------------------------------ | ------------------------------------------- |
| **Frontend**       | React + React Query (TanStack Query)       | UI, estado del servidor, caché, reintentos. |
| **Backend**        | Node.js + NestJS (modular)                 | Lógica de negocio, API REST, validación.    |
| **Autenticación**  | JWT + OAuth2 (Auth0/Keycloak)              | Identidad, roles, permisos.                 |
| **Datos**          | PostgreSQL (transaccional) + Redis (caché) | Persistencia ACID, caché de lecturas.       |
| **Caché**          | Redis                                      | Catálogo, sesiones, reservas temporales.    |
| **Mensajería**     | RabbitMQ (o Kafka) + Outbox                | Eventos asíncronos, desacoplamiento.        |
| **Imágenes**       | S3 + CloudFront (CDN)                      | Almacenamiento y distribución de imágenes.  |
| **Observabilidad** | OpenTelemetry, Prometheus, Grafana, Loki   | Métricas, trazas, logs, alertas.            |

### 16. Consistencia fuerte vs. eventual

| **Consistencia fuerte (ACID)**                             | **Consistencia eventual**                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Inventario (no vender sin stock)                           | Catálogo (precio/nombre puede tardar ms en actualizarse)                  |
| Creación de orden y descuento de stock (misma transacción) | Notificaciones (email puede llegar segundos después)                      |
| Saldo/pago (debe ser exacto)                               | Vistas de reportes analíticos (pueden estar unos minutos desactualizados) |
| Idempotencia de órdenes                                    | Sincronización de imágenes con CDN                                        |
| Reserva temporal de inventario                             | Actualización de estado en el frontend (WebSocket)                        |

### 17. Evitar overselling, cobros duplicados y webhooks duplicados

- **Overselling:**
  - **Pesimistic Locking:** `SELECT ... FROM inventory WHERE sku = $1 FOR UPDATE` dentro de la transacción. Bloquea la fila hasta el commit, impidiendo que dos transacciones lean el mismo stock.
  - **Alternativa optimista:** `UPDATE inventory SET stock = stock - $1 WHERE sku = $2 AND stock >= $1 RETURNING stock;` – Atómico, sin locks explícitos, pero puede fallar bajo alta contención.
  - **Reserva temporal en Redis:** Para picos altos, usar `SETNX` o scripts Lua para reservar unidades con TTL, y luego confirmar en BD. Esto reduce la contención en PostgreSQL.
- **Cobros duplicados:**
  - **Idempotency-Key en la API de pagos:** El backend envía una clave de idempotencia al proveedor de pagos (Stripe la soporta nativamente). Si se reintenta, el proveedor devuelve el mismo cobro.
  - **Estado de la orden:** Antes de llamar al proveedor, verificar que la orden esté en `PENDING_PAYMENT`. Si ya está `PAID`, no volver a cobrar.
- **Webhooks duplicados:**
  - **Tabla de eventos procesados:** Guardar el `event_id` del webhook en una tabla `processed_webhook_events` con una restricción `UNIQUE`. Si el evento ya existe, responder 200 sin reprocesar.
  - **Verificación de firma:** Validar la firma HMAC del webhook para asegurar autenticidad.

### 18. Escalar y recuperarse de fallas

**Escalabilidad:**

- **Horizontal:** Stateless backend detrás de un balanceador (ALB). Escalar réplicas según CPU/RPS.
- **Base de datos:** Réplicas de lectura para catálogo; particionamiento de `orders` por fecha; connection pooling (PgBouncer).
- **Caché:** Redis Cluster para catálogo y sesiones.
- **Asincronía:** Colas para picos (ej. procesamiento de imágenes, notificaciones).

**Recuperación:**

- **Backups:** PostgreSQL con PITR (Point-In-Time Recovery) y backups diarios verificados.
- **Multi-AZ:** Desplegar en al menos 2 zonas de disponibilidad.
- **Circuit Breaker:** Para llamadas al proveedor de pagos (si falla, abrir circuito y reintentar con backoff).
- **Dead Letter Queue (DLQ):** Para mensajes que no se pueden procesar.
- **Health checks y auto-scaling:** Kubernetes con liveness/readiness probes.

### 19. Monolito modular vs. microservicios

**¿Por qué monolito modular inicialmente?**

- El equipo es pequeño y el dominio aún no está completamente entendido.
- Menor complejidad operativa (un solo despliegue, una sola BD).
- Transacciones ACID sencillas (inventario + orden en la misma BD).
- Los microservicios añaden latencia de red, consistencia eventual y complejidad de observabilidad.

**¿Cuándo separar en servicios?**

- Cuando un módulo tenga un ciclo de despliegue diferente (ej. Pasarela de pagos).
- Cuando se necesite escalar un módulo independientemente (ej. Catálogo con alto tráfico de lectura).
- Cuando el equipo crezca y se divida en equipos autónomos por dominio.
- **Candidatos naturales:** Pagos (por su criticidad y compliance PCI), Notificaciones (asíncrono), Catálogo (alto volumen de lectura).

### 20. Nube y 5 decisiones técnicas

**Nube elegida:** AWS (agnóstica pero con servicios gestionados).

1. **RDS PostgreSQL Multi-AZ** en lugar de auto-gestionado: backups automáticos, failover, PITR.
2. **ECS Fargate o EKS** para el backend: escalabilidad sin gestionar servidores; Fargate reduce la carga operativa.
3. **ElastiCache Redis** para caché y reservas: baja latencia, gestionado.
4. **SQS/RabbitMQ gestionado (Amazon MQ)** para colas: desacoplamiento y durabilidad.
5. **CloudFront + S3** para imágenes: CDN global, bajo costo, alta disponibilidad.

**Trade-offs:** Se prioriza la simplicidad operativa sobre el control total. No se usan microservicios ni Kubernetes desde el día 1 porque no hay una razón técnica que lo justifique; se evaluará cuando la escala o el equipo lo requieran.

---

## 3. Implementación backend + datos

### 21. Validaciones de entrada

- `customerId`: string no vacío, formato válido (ej. `C-` + dígitos), existencia en BD.
- `items`: array no vacío, máximo 50 ítems.
  - `sku`: string alfanumérico, existente en catálogo.
  - `quantity`: entero positivo, máximo por ítem (ej. 10).
- `Idempotency-Key`: header obligatorio, UUID v4 válido.
- Validación de Content-Type: `application/json`.
- Sanitización de payload para evitar mass assignment.

### 22. Código/pseudocódigo que garantiza stock no negativo

**Opción A: Pessimistic Locking (recomendado para baja/media contención)**

```typescript
async function createOrder(
  customerId: string,
  items: OrderItem[],
  idempotencyKey: string,
) {
  return await db.transaction(async (tx) => {
    // 1. Verificar idempotencia (dentro o fuera de la transacción, ver punto 24)
    const existing = await tx.query(
      "SELECT response FROM idempotency_keys WHERE key = $1 AND customer_id = $2",
      [idempotencyKey, customerId],
    );
    if (existing.rows.length > 0) {
      return existing.rows[0].response; // Replay
    }

    // 2. Bloquear y validar stock de cada SKU en orden consistente (evitar deadlocks)
    const sortedItems = items.sort((a, b) => a.sku.localeCompare(b.sku));
    for (const item of sortedItems) {
      const inv = await tx.query(
        "SELECT stock FROM inventory WHERE sku = $1 FOR UPDATE",
        [item.sku],
      );
      if (inv.rows.length === 0 || inv.rows[0].stock < item.quantity) {
        throw new InsufficientStockError(item.sku);
      }
      // 3. Descontar stock
      await tx.query("UPDATE inventory SET stock = stock - $1 WHERE sku = $2", [
        item.quantity,
        item.sku,
      ]);
    }

    // 4. Crear orden
    const order = await tx.query(
      `INSERT INTO orders (customer_id, status, total)
       VALUES ($1, 'PENDING_PAYMENT', $2) RETURNING id`,
      [customerId, calculateTotal(items)],
    );

    // 5. Insertar ítems
    for (const item of items) {
      await tx.query(
        "INSERT INTO order_items (order_id, sku, quantity, unit_price) VALUES ($1, $2, $3, $4)",
        [order.rows[0].id, item.sku, item.quantity, item.unitPrice],
      );
    }

    // 6. Guardar idempotencia
    const response = { orderId: order.rows[0].id, status: "PENDING_PAYMENT" };
    await tx.query(
      "INSERT INTO idempotency_keys (key, customer_id, response) VALUES ($1, $2, $3)",
      [idempotencyKey, customerId, JSON.stringify(response)],
    );

    return response;
  });
}
```

**Opción B: Optimistic Locking (mejor para alta concurrencia)**

```sql
UPDATE inventory
SET stock = stock - $1
WHERE sku = $2 AND stock >= $1
RETURNING stock;
```

Si `rowCount === 0`, no hay stock suficiente. Se puede reintentar o devolver 409.

### 23. Dónde comienza y termina la transacción

- **Comienza** inmediatamente después de validar la idempotencia (si no existe la clave) y antes de bloquear el primer SKU.
- **Termina** (commit) después de insertar la orden, los ítems y la clave de idempotencia.
- **Excepción:** La llamada al proveedor de pagos **NO** debe estar dentro de la transacción (ver punto 27).

### 24. Mecanismo de idempotencia

- **Tabla `idempotency_keys`:** Almacena `key` (UUID), `customer_id`, `request_hash` (para detectar reutilización con payload diferente), `response` (JSON de la respuesta), `created_at`, `expires_at`.
- **Flujo:**
  1. Si la clave existe y el `request_hash` coincide → devolver la respuesta guardada (200).
  2. Si la clave existe pero el `request_hash` difiere → devolver `409 Conflict` (reutilización indebida).
  3. Si no existe → procesar la orden y guardar la clave + respuesta en la misma transacción.
- **TTL:** Las claves expiran a las 24–48 horas para evitar crecimiento indefinido.

### 25. Códigos HTTP y estructura de errores

| Situación                         | Código                        | Cuerpo de error                                                                                                 |
| --------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Datos inválidos (validación)      | **400 Bad Request**           | `{ "error": "VALIDATION_ERROR", "details": [{ "field": "items[0].quantity", "message": "must be positive" }] }` |
| No autenticado                    | **401 Unauthorized**          | `{ "error": "UNAUTHENTICATED" }`                                                                                |
| No autorizado (otro cliente)      | **403 Forbidden**             | `{ "error": "FORBIDDEN" }`                                                                                      |
| Recurso inexistente (SKU)         | **404 Not Found**             | `{ "error": "SKU_NOT_FOUND", "sku": "SKU-999" }`                                                                |
| Falta de stock                    | **409 Conflict**              | `{ "error": "INSUFFICIENT_STOCK", "sku": "SKU-001", "available": 0 }`                                           |
| Idempotencia con payload distinto | **409 Conflict**              | `{ "error": "IDEMPOTENCY_CONFLICT", "message": "Key reused with different payload" }`                           |
| Error interno                     | **500 Internal Server Error** | `{ "error": "INTERNAL_ERROR", "traceId": "abc-123" }`                                                           |

### 26. Modelo mínimo de tablas

```sql
-- Clientes (simplificado)
CREATE TABLE customers (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

-- Productos (catálogo)
CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  image_url TEXT
);

-- Inventario
CREATE TABLE inventory (
  sku TEXT PRIMARY KEY REFERENCES products(sku),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Órdenes
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  total NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ítems de orden
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL REFERENCES products(sku),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL
);

-- Idempotencia
CREATE TABLE idempotency_keys (
  key UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- Reservas temporales (alternativa/complemento a inventory.stock)
CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  sku TEXT NOT NULL REFERENCES products(sku),
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, CONFIRMED, EXPIRED
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_expires ON reservations(expires_at) WHERE status = 'ACTIVE';
```

### 27. Integración del pago externo sin transacción abierta

**Patrón: Transactional Outbox + Saga / Coreografía**

1. La orden se crea y se guarda en estado `PENDING_PAYMENT` dentro de una transacción corta. Se inserta un evento `OrderCreated` en la tabla `outbox` en la misma transacción.
2. Un **worker** lee el outbox y publica el evento en la cola. Un consumidor del módulo de Pagos lo recibe.
3. El módulo de Pagos **no tiene transacción de BD abierta**. Llama al proveedor externo con una `Idempotency-Key`.
4. Si el proveedor responde síncronamente (éxito/fracaso), el módulo de Pagos actualiza la orden en una nueva transacción corta.
5. Si el proveedor responde asíncronamente (webhook), el webhook actualiza la orden en una transacción corta.
6. **Circuit Breaker:** Si el proveedor está lento o falla, se abre el circuito y se reintenta con backoff exponencial. La orden permanece en `PENDING_PAYMENT` hasta que se confirme o expire.

---

## 4. Frontend y experiencia de usuario

### 28. Estados de UI

| Estado             | Descripción                                                 | UI                                                                                                             |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `idle`             | Pantalla lista, sin acción.                                 | Botón "Pagar" habilitado.                                                                                      |
| `validating`       | Validando campos del formulario (dirección, etc.).          | Spinner sutil, botón deshabilitado.                                                                            |
| `submitting`       | POST enviado, esperando respuesta (300ms – 4s).             | Botón muestra spinner y texto "Procesando...". Se bloquea para evitar doble envío.                             |
| `confirmed`        | Orden creada y pago confirmado.                             | Pantalla de éxito con número de orden y resumen.                                                               |
| `recoverableError` | Error de red o timeout, pero la orden puede haberse creado. | Mensaje "No pudimos confirmar tu pago. Revisa tus pedidos o reintenta." Botón "Reintentar" (con idempotencia). |
| `definitiveError`  | Error de validación o stock insuficiente.                   | Mensaje claro (ej. "El producto X ya no está disponible"). Botón "Volver al carrito".                          |

### 29. Evitar doble clic sin bloquear al usuario para siempre

- **Deshabilitar el botón** mientras `status === 'submitting'` (no para siempre, solo durante la petición).
- **Timeout:** Si la petición no responde en 10 segundos, transicionar a `recoverableError` y rehabilitar el botón con una advertencia. El usuario puede reintentar (la idempotencia evita duplicados).
- **Idempotency-Key:** Generar una clave única al iniciar el checkout y reutilizarla en los reintentos. Así, si el usuario hace doble clic rápido, el backend solo crea una orden.

### 30. Pérdida de conexión después del POST

- **No asumir que la orden no se creó.** Al recuperar la conexión, el frontend debe:
  1. Consultar `GET /api/v1/orders?clientGeneratedId=...` (usando un `clientOrderId` generado antes del POST) para verificar si la orden existe.
  2. Si existe, mostrar la confirmación.
  3. Si no existe, permitir reintentar el POST con la **misma Idempotency-Key** (el backend devolverá la orden si ya fue creada, o la creará si no).
- **Persistencia local:** Guardar el `clientOrderId` y la `Idempotency-Key` en `localStorage`/`sessionStorage` antes de enviar el POST, para poder recuperarlos tras una recarga o pérdida de conexión.

### 31. Accesibilidad mínima

- **Formulario:** Cada input con `<label htmlFor="...">`; `aria-required="true"` en campos obligatorios; `aria-describedby` para mensajes de ayuda.
- **Errores:** Contenedor con `role="alert"` y `aria-live="assertive"` para anunciar errores a lectores de pantalla. El foco debe moverse al primer campo con error.
- **Botón de pago:** `aria-busy="true"` durante el envío; `aria-disabled="true"` cuando esté deshabilitado. Texto claro ("Pagar $1,234.56").
- **Contraste:** Cumplir WCAG AA (4.5:1 para texto normal).
- **Navegación por teclado:** Todos los controles accesibles con Tab; orden lógico de foco.

### 32. Estado local vs. global vs. server state

| Tipo de estado          | Ejemplos                                                                                         | Herramienta                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Local (UI)**          | Texto del input de dirección, estado del botón (idle/submitting), visibilidad de un tooltip.     | `useState`                                                                                   |
| **Global (compartido)** | Carrito de compras (múltiples componentes lo necesitan), tema (dark/light), usuario autenticado. | Context API, Zustand, Redux (para carrito)                                                   |
| **Server State**        | Productos del catálogo, órdenes del usuario, stock disponible.                                   | React Query (TanStack Query) o SWR – manejan caché, revalidación, reintentos, loading/error. |

**Regla:** No duplicar server state en el estado global. React Query es la fuente de verdad para datos del servidor; el estado global solo para UI compartida.

---

## 5. Testing, seguridad y diagnóstico

### Pruebas prioritarias (8)

| #   | Tipo                           | Prueba                                                                                                                      | Objetivo                                    |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | **Unitaria**                   | `calculateTotal(items)` con precios y cantidades variadas.                                                                  | Verificar cálculo correcto.                 |
| 2   | **Unitaria**                   | `validateOrderInput(payload)` con payloads inválidos (quantity negativa, SKU vacío).                                        | Asegurar validación robusta.                |
| 3   | **Integración**                | `POST /orders` con stock suficiente → 201 y stock descontado.                                                               | Flujo feliz.                                |
| 4   | **Integración**                | `POST /orders` con stock insuficiente → 409 y stock intacto.                                                                | Prevención de overselling.                  |
| 5   | **Integración (concurrencia)** | Dos hilos simultáneos compran la última unidad → solo uno tiene éxito, el otro recibe 409.                                  | Verificar `SELECT FOR UPDATE` / atomicidad. |
| 6   | **Integración (idempotencia)** | Dos `POST` con la misma `Idempotency-Key` y mismo payload → segunda respuesta es idéntica (200), no se crea segunda orden.  | Prevenir duplicados.                        |
| 7   | **E2E**                        | Flujo completo: agregar al carrito → checkout → pagar (mock del proveedor) → confirmación visible.                          | Validar integración frontend-backend.       |
| 8   | **E2E (resiliencia)**          | Simular timeout del proveedor de pagos y verificar que la orden queda `PENDING_PAYMENT` y el webhook posterior la confirma. | Probar el patrón Outbox/Saga.               |

### Riesgos OWASP Top 10 y controles

| Riesgo OWASP                           | Relevancia en CommerceHub                              | Control concreto                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **A01: Broken Access Control**         | Un usuario puede ver/modificar órdenes de otro (IDOR). | Autorización a nivel de objeto: verificar que `req.user.id === order.customerId`; usar UUIDs no predecibles; deny by default.                |
| **A02: Cryptographic Failures**        | Datos de pago/tarjetas expuestos.                      | **Nunca** almacenar números de tarjeta. Usar tokenización del proveedor (Stripe Elements). TLS en tránsito; secretos en KMS/Secrets Manager. |
| **A03: Injection**                     | SQL Injection en búsquedas de productos.               | Consultas parametrizadas en todas las queries; validación de entrada con Zod; ORM seguro.                                                    |
| **A04: Insecure Design**               | Lógica de negocio sin límites (ej. precios negativos). | Modelado de amenazas; validar cantidades positivas; límites de tasa; revisar flujos de negocio.                                              |
| **A05: Security Misconfiguration**     | Stack traces expuestas, CORS abierto.                  | Deshabilitar `x-powered-by`; CORS restrictivo; headers de seguridad (Helmet); entornos separados.                                            |
| **A06: Vulnerable Components**         | Dependencias con CVEs conocidos.                       | `npm audit` / Snyk en CI; Dependabot; lockfiles; SBOM.                                                                                       |
| **A07: Authentication Failures**       | Fuerza bruta en login.                                 | Rate limiting en auth; bloqueo temporal; MFA para admin; JWT con expiración corta + refresh token.                                           |
| **A08: Integrity Failures**            | Webhooks falsificados.                                 | Verificar firma HMAC del proveedor de pagos; no deserializar datos no confiables.                                                            |
| **A09: Logging & Monitoring Failures** | No detectar un ataque.                                 | Logs estructurados con correlation ID; alertas en intentos de acceso denegado; auditoría de acciones administrativas.                        |
| **A10: SSRF**                          | Subida de imágenes desde URL externa.                  | Validar URLs; usar lista blanca; no permitir IPs internas.                                                                                   |

### Investigación de órdenes duplicadas con proveedor lento

1. **Reproducir:** Simular latencia del proveedor (ej. 10s) y enviar múltiples `POST /orders` con la misma y diferente `Idempotency-Key`.
2. **Revisar logs:** Buscar en logs el `traceId` de las órdenes duplicadas. Verificar si la `Idempotency-Key` se está enviando y si la tabla `idempotency_keys` tiene registros duplicados.
3. **Inspeccionar la BD:** Verificar si hay dos órdenes con el mismo `customer_id` y `total` en un rango de tiempo corto. Revisar si el `webhook` se procesó dos veces.
4. **Analizar el flujo:** ¿El reintento del frontend usa la misma clave? ¿El backend valida la idempotencia antes de la transacción? ¿La transacción se abre antes de tiempo?
5. **Corregir:** Asegurar que la validación de idempotencia ocurra **dentro** de la transacción (o con un lock distribuido) para evitar condiciones de carrera donde dos peticiones pasan la verificación antes de que alguna escriba la clave.

### Migración de columna sin interrumpir servicio

**Patrón: Expand-Contract (Parallel Change)**

1. **Expand:** Agregar la nueva columna (nullable) sin eliminar la antigua. Desplegar backend que escribe en **ambas** columnas y lee de la nueva (con fallback a la antigua).
2. **Migrar datos:** Script batch que copia datos de la columna antigua a la nueva (en segundo plano, por lotes).
3. **Contract:** Cuando todos los datos estén migrados y el backend estable, eliminar la escritura en la columna antigua. Desplegar. Finalmente, eliminar la columna antigua en una migración posterior.
4. **Rollback:** Si algo falla, el backend anterior sigue funcionando porque la columna antigua aún existe.

---

## 6. DevOps y operación

### 33. Pipeline CI/CD mínimo

```
Pull Request → [CI] Lint → Tests → SAST → Build → [CD] Deploy a Staging → Smoke Tests → Deploy a Producción (Canary/Blue-Green)
```

### 34. Dónde ejecutar cada etapa

| Etapa                                         | Dónde                                             | Herramienta                             |
| --------------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| **Linting**                                   | En cada PR (pre-commit y CI)                      | ESLint, Prettier                        |
| **Pruebas unitarias/integración**             | CI (GitHub Actions, GitLab CI)                    | Jest, Vitest, Supertest                 |
| **Análisis de dependencias/vulnerabilidades** | CI (en cada PR y nightly)                         | `npm audit`, Snyk, Dependabot           |
| **Build**                                     | CI, después de tests exitosos                     | Docker build, `npm run build`           |
| **Migraciones**                               | CD, antes del despliegue de la app (job separado) | Flyway, Prisma Migrate, node-pg-migrate |
| **Deploy a Staging**                          | CD, automático al mergear a `main`                | ArgoCD, GitHub Actions                  |
| **Smoke Tests**                               | Post-deploy en Staging                            | Playwright, Cypress                     |
| **Deploy a Producción**                       | CD, manual approval + canary                      | Argo Rollouts, AWS CodeDeploy           |

### 35. Estrategia de rollback

- **Blue-Green:** Mantener dos entornos idénticos. Desplegar en "green", probar, cambiar el tráfico. Si falla, revertir el tráfico a "blue" instantáneamente.
- **Canary:** Desplegar a un pequeño porcentaje de usuarios (5%), monitorear métricas (errores, latencia). Si hay degradación, rollback automático.
- **Rollback de BD:** Las migraciones deben ser **backward-compatible** (patrón Expand-Contract). Para rollback de datos, tener backups PITR. Nunca hacer `DROP COLUMN` en el mismo despliegue que elimina el código que la usa.

### 36. Almacenamiento de secretos

- **Nunca** en el repositorio ni en variables de entorno de CI sin cifrar.
- Usar **AWS Secrets Manager** o **HashiCorp Vault** para secretos de producción (DB passwords, API keys).
- **Doppler** o **GitHub Secrets** (cifrados) para CI/CD.
- Rotación automática cada 90 días.
- Inyección en runtime (no en build) mediante el orquestador (K8s Secrets, ECS Task Definitions con `secrets`).

### 37. Métricas y alertas críticas para checkout

| Métrica                                     | Alerta                                   |
| ------------------------------------------- | ---------------------------------------- |
| **Tasa de errores 5xx en `/orders`**        | > 1% durante 5 min                       |
| **Latencia p95 de `POST /orders`**          | > 2s durante 5 min                       |
| **Tasa de órdenes creadas vs. confirmadas** | Desviación > 10% (indica fallos en pago) |
| **Stock negativo (inventario)**             | Cualquier valor < 0 (alerta crítica)     |
| **Tamaño de la cola de outbox**             | > 1000 mensajes pendientes               |
| **Circuit breaker del proveedor de pagos**  | Estado abierto durante > 1 min           |
| **Errores de webhook (firma inválida)**     | > 0 en 5 min (posible ataque)            |
| **Uso de CPU/memoria del backend**          | > 80% durante 10 min                     |

---

## 7. Comunicación técnica

**Decisión más riesgosa:** Usar un **monolito modular** con una única base de datos PostgreSQL para inventario y órdenes, en lugar de separar Inventario como un servicio independiente con su propia BD y consistencia eventual.

**Alternativa evaluada:** Microservicio de Inventario con Redis como almacén principal de stock y sincronización asíncrona con PostgreSQL. Esta alternativa ofrece mayor escalabilidad horizontal y aislamiento de fallos, pero introduce complejidad de consistencia eventual, riesgo de overselling si la sincronización falla, y una carga operativa significativa (nuevo servicio, nueva BD, observabilidad distribuida).

**Información necesaria para confirmar la decisión:**

1. **Patrón de tráfico real:** ¿Los picos de 8,000 usuarios concurrentes se concentran en pocos SKUs ("hot SKUs")? Si es así, el lock pesimista en PostgreSQL podría generar contención y latencias p99 altas, haciendo necesaria la alternativa con Redis.
2. **Tolerancia a la inconsistencia:** ¿El negocio acepta que, en raras ocasiones, se venda una unidad sin stock real (y se compense con reembolso), o el overselling es absolutamente inaceptable? Si es inaceptable, el monolito con transacciones ACID es más seguro.
3. **Tamaño y madurez del equipo:** ¿Hay suficiente experiencia operativa para mantener un microservicio adicional? Un equipo pequeño se beneficia del monolito; un equipo grande con equipos por dominio puede justificar la separación.
4. **Costo:** El costo de infraestructura de Redis Cluster + microservicio vs. escalar verticalmente PostgreSQL (instancias más grandes, PgBouncer).

Con estos datos, se podría validar la decisión o planificar una extracción gradual del módulo de Inventario cuando la contención en PostgreSQL supere un umbral medible (ej. p99 > 1s en `SELECT FOR UPDATE`).

---

## Supuestos declarados

- El backend usa Node.js con PostgreSQL (se asume `pg` como driver).
- El frontend usa React con hooks funcionales.
- El proveedor de pagos es externo y soporta idempotencia (ej. Stripe).
- Se prioriza la simplicidad y la mantenibilidad sobre la optimización prematura.
- La autenticación se basa en JWT con un API Gateway que valida el token.
- El equipo es pequeño/mediano, lo que justifica el monolito modular inicial.

Esta resolución equilibra **seguridad, rendimiento, mantenibilidad y calidad de decisiones**, aplicando patrones como Repository, Unit of Work, Transactional Outbox, Idempotency, Pessimistic Locking, Circuit Breaker y Expand-Contract, sin caer en sobredimensionamiento.
