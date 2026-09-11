-- ==================================================================
-- HARD STREET - SEED / AJUSTES DE DATOS
-- Ejecutar DESPUES del script de esquema que ya tienes.
--   psql "$DATABASE_URL" -f backend/db/seed.sql
--
-- Que hace:
--   1. Contrasenas bcrypt para los 2 usuarios existentes
--   2. Paquetes faltantes por categoria y tier (el front los muestra todos)
--   3. Servicios externos destacados (carousel de la landing)
--   4. Galeria de ejemplo ligada al paquete comprado
--   5. Estatus globales extra para purchased_packages (Pagado / Cancelado)
-- ==================================================================

-- ---------------------------------------------------------------
-- 1) CONTRASENAS (bcrypt, costo 10) - generadas con bcryptjs
--    Admin  hardstreet7@gmail.com     -> admin123
--    Cliente karimedzul@hardstreet.com -> cliente123
--    (VERIFICADAS con bcrypt.compareSync; no editar a mano)
-- ---------------------------------------------------------------
UPDATE "users" SET "password" = '$2b$10$NFjeN.Xz7gtAHLtND4wp/uWvRAQ9Lu8l7JYabv/ZZkatkIhUxzHGu'
 WHERE "email" = 'hardstreet7@gmail.com';

UPDATE "users" SET "password" = '$2b$10$.3ttEElqWEeqD4haJAUuxeA08LsfFGIISNVV8S50C9HlCAgY5kkP6'
 WHERE "email" = 'karimedzul@hardstreet.com';

-- ---------------------------------------------------------------
-- 2) PAQUETES FALTANTES
--    (Tu BD solo tenia el paquete 1; el front agrupa por categoria/tier)
-- ---------------------------------------------------------------
INSERT INTO "packages" ("id", "name", "subtitle", "description", "price", "currency", "id_tier", "id_package_category", "is_extern", "url_image")
OVERRIDING SYSTEM VALUE VALUES
  -- Boda
  (2,  'Boda - Gold',       'HardStreet Estudio de Fotografía y Vídeo', 'Cobertura esencial de tu boda',   8500, 'MXN', 2, 1, 0, NULL),
  (3,  'Boda - Basic',      'HardStreet Estudio de Fotografía y Vídeo', 'Lo indispensable para tu día',    6500, 'MXN', 3, 1, 0),
  -- XV Años
  (4,  'XV Años - Premium', 'HardStreet Estudio de Fotografía y Vídeo', 'El paquete mas completo',        9950, 'MXN', 1, 2, 0),
  (5,  'XV Años - Gold',    'HardStreet Estudio de Fotografía y Vídeo', 'Cobertura destacada',            7500, 'MXN', 2, 2, 0),
  (6,  'XV Años - Basic',   'HardStreet Estudio de Fotografía y Vídeo', 'Lo esencial para tus XV',        5200, 'MXN', 3, 2, 0),
  -- Bautizo
  (7,  'Bautizo - Gold',    'HardStreet Estudio de Fotografía y Vídeo', 'Recuerda este día especial',     6800, 'MXN', 2, 3, 0),
  (8,  'Bautizo - Basic',   'HardStreet Estudio de Fotografía y Vídeo', 'Cobertura sencilla',             4500, 'MXN', 3, 3, 0),
  -- Graduación
  (9,  'Graduación - Gold', 'HardStreet Estudio de Fotografía y Vídeo', 'Celebra tu logro',               5500, 'MXN', 2, 4, 0),
  (10, 'Graduación - Basic','HardStreet Estudio de Fotografía y Vídeo', 'Sesión de graduación',           3200, 'MXN', 3, 4, 0),
  -- Comercial
  (11, 'Sesión Fotográfica',        'Sesión personalizada en estudio o exteriores', 'Sesión para marcas y personas', 2500, 'MXN', 3, 5, 0),
  (12, 'Fotografía Comercial',      'Para negocios y marca personal',               'Producto y publicidad',         3500, 'MXN', 2, 5, 0),
  (13, 'Marca Personal - Premium',  'Sesión completa para profesionales',           'Branding visual completo',      4800, 'MXN', 1, 5, 0),
  (14, 'Publicidad Digital',        'Contenido para redes y marketing',             'Flyers y contenido digital',    2800, 'MXN', 3, 5, 0)
ON CONFLICT ("id") DO NOTHING;

-- Servicios por paquete (replicando la logica original del front)
INSERT INTO "packages_services" ("id", "id_package", "id_service")
OVERRIDING SYSTEM VALUE VALUES
  -- Boda Gold (2): highlights, cobertura 7h, 400 fotos, 50 impresas
  (9,  2, 2), (10, 2, 5), (11, 2, 6), (12, 2, 7),
  -- Boda Basic (3): cobertura 7h, 400 fotos, misa
  (13, 3, 5), (14, 3, 6), (15, 3, 9),
  -- XV Premium (4): 9 servicios
  (16, 4, 9), (17, 4, 10), (18, 4, 11), (19, 4, 12), (20, 4, 13),
  (21, 4, 3), (22, 4, 15), (23, 4, 16), (24, 4, 14),
  -- XV Gold (5)
  (25, 5, 10), (26, 5, 11), (27, 5, 12), (28, 5, 13), (29, 5, 15),
  -- XV Basic (6)
  (30, 6, 11), (31, 6, 13), (32, 6, 15),
  -- Bautizo Gold (7)
  (33, 7, 9), (34, 7, 11), (35, 7, 12), (36, 7, 13), (37, 7, 3), (38, 7, 15), (39, 7, 16),
  -- Bautizo Basic (8)
  (40, 8, 9), (41, 8, 11), (42, 8, 13), (43, 8, 15),
  -- Graduacion Gold (9)
  (44, 9, 11), (45, 9, 12), (46, 9, 13), (47, 9, 3), (48, 9, 15), (49, 9, 16),
  -- Graduacion Basic (10)
  (50, 10, 11), (51, 10, 13), (52, 10, 15),
  -- Comercial
  (53, 11, 17), (54, 11, 6), (55, 11, 7),
  (56, 12, 19), (57, 12, 20), (58, 12, 21),
  (59, 13, 21), (60, 13, 20), (61, 13, 19), (62, 13, 6),
  (63, 14, 20), (64, 14, 19), (65, 14, 21)
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------
-- 3) SERVICIOS EXTERNOS (carousel "Lo que Ofrecemos", is_extern = 1)
-- ---------------------------------------------------------------
INSERT INTO "packages" ("id", "name", "subtitle", "description", "price", "currency", "id_tier", "id_package_category", "is_extern", "url_image")
OVERRIDING SYSTEM VALUE VALUES
  (21, 'Fotografía de Eventos',  'Capturando momentos inolvidables', 'Cobertura completa de bodas, quinceañeros, bautizos y graduaciones con estilo único y artístico.', 2500, 'MXN', 1, 1, 1, 'images/boungle.jpg'),
  (22, 'Vídeo Cinematográfico',  'Historias que cobran vida',        'Videos con narrativa cinematográfica, highlights y servicio aéreo con dron.',                       5000, 'MXN', 1, 1, 1, 'images/banner.jpg'),
  (23, 'Medios Visuales',        'Contenido que impacta',            'Flyers, publicidad, fotografía de producto y contenido para redes sociales.',                       1500, 'MXN', 2, 5, 1, 'images/review.jpg'),
  (24, 'Publicidad Digital',     'Haz crecer tu negocio',            'Campañas visuales que aumentan la visibilidad de tu marca.',                                        2000, 'MXN', 2, 5, 1, 'images/banner1.jpg'),
  (25, 'Invitaciones Digitales', 'Diseño exclusivo y moderno',       'Invitaciones digitales personalizadas con animaciones y música.',                                    800, 'MXN', 3, 5, 1, 'images/after_p.jpg'),
  (26, 'Podcast',                'Tu voz, nuestro estilo',           'Producción completa de podcast: grabación, edición y distribución.',                                3000, 'MXN', 3, 5, 1, 'images/before_p.jpg')
ON CONFLICT ("id") DO NOTHING;

-- Si ya tenias los servicios externos insertados, actualiza sus imagenes:
UPDATE "packages" SET "url_image" = 'images/boungle.jpg'
  WHERE "is_extern" = 1 AND "id" = 21;
UPDATE "packages" SET "url_image" = 'images/banner.jpg'
  WHERE "is_extern" = 1 AND "id" = 22;
UPDATE "packages" SET "url_image" = 'images/review.jpg'
  WHERE "is_extern" = 1 AND "id" = 23;
UPDATE "packages" SET "url_image" = 'images/banner1.jpg'
  WHERE "is_extern" = 1 AND "id" = 24;
UPDATE "packages" SET "url_image" = 'images/after_p.jpg'
  WHERE "is_extern" = 1 AND "id" = 25;
UPDATE "packages" SET "url_image" = 'images/before_p.jpg'
  WHERE "is_extern" = 1 AND "id" = 26;

-- Servicios especificos de los paquetes externos (23-25 los necesitan)
INSERT INTO "services" ("id", "name", "description", "icon")
OVERRIDING SYSTEM VALUE VALUES
  (22, 'Contenido para Redes Sociales', 'Diseño y fotografía para redes sociales', 'icon/photos.svg'),
  (23, 'Diseño de Invitaciones Digitales', 'Invitaciones digitales personalizadas con animaciones', 'icon/flyer.svg'),
  (24, 'Producción de Podcast', 'Grabación, edición y distribución de podcast', 'icon/mic.svg')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "packages_services" ("id", "id_package", "id_service")
OVERRIDING SYSTEM VALUE VALUES
  (71, 21, 17), (72, 21, 6), (73, 21, 7), (74, 21, 8),
  (75, 22, 1),  (76, 22, 2), (77, 22, 3), (78, 22, 5),
  -- 23 Medios Visuales: flyer + producto + redes
  (79, 23, 20), (80, 23, 19), (81, 23, 22),
  -- 24 Publicidad Digital: flyer + redes + marca personal
  (82, 24, 20), (83, 24, 22), (84, 24, 21),
  -- 25 Invitaciones Digitales: diseno de invitaciones + sesion
  (85, 25, 23), (86, 25, 17),
  -- 26 Podcast: produccion de podcast + video cinematografico
  (87, 26, 24), (88, 26, 1)
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------
-- 3b) CAMPO NUEVO: url_image en packages (imagenes del carousel)
--     Ejecutar una sola vez si tu tabla packages aun no lo tiene:
-- ---------------------------------------------------------------
ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "url_image" varchar;

-- ---------------------------------------------------------------
-- 4) ESTATUS GLOBALES EXTRA para purchased_packages
--    (1 Pendiente, 2 En proceso, 3 Entregado ya existen)
-- ---------------------------------------------------------------
INSERT INTO "status" ("id", "name")
OVERRIDING SYSTEM VALUE VALUES
  (4, 'Pagado'),
  (5, 'Cancelado')
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------
-- 5) GALERIA DE EJEMPLO
--    (imagenes demo del repositorio; id_gallery_type: 1=image, 2=video)
-- ---------------------------------------------------------------
-- Galeria demo: fotos publicas (is_public=1) en varias categorias para
-- los filtros de "Galeria Destacada" (cat: 1 Boda, 2 XV, 3 Bautizo, 4 Graduacion, 5 Comercial)
INSERT INTO "galleries" ("id", "url", "id_user", "id_gallery_type", "id_purchased_package", "id_package_category", "is_public")
OVERRIDING SYSTEM VALUE VALUES
  (2,  'images/banner.jpg',    2, 1, 1, 1, 1),
  (3,  'images/banner1.jpg',   2, 1, 1, 2, 1),
  (4,  'images/review.jpg',    2, 1, 1, 5, 1),
  (5,  'images/boungle.jpg',   2, 1, 1, 3, 1),
  (6,  'images/after_p.jpg',   2, 1, 1, 4, 1),
  (7,  'images/before_p.jpg',  2, 1, 1, 2, 1),
  (8,  'images/banner.jpg',    2, 1, 1, 1, 0),
  (9,  'images/banner1.jpg',   2, 1, 1, 5, 0),
  (10, 'images/before_p.jpg',  2, 1, 1, 3, 1),
  (11, 'images/after_p.jpg',   2, 1, 1, 4, 1)
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------
-- 6) NOTA: purchased_packages_services.delivery_date es INTEGER (dias)
--    Si quieres guardar una FECHA de entrega real, considera:
--      ALTER TABLE purchased_packages_services
--        ADD COLUMN delivery_date_ts timestamp;
--    El backend lo expone como deliveryDate (dias) tal cual esta en BD.
-- ---------------------------------------------------------------
