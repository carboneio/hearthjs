SELECT name AS table_name
  FROM pragma_table_list
 WHERE schema = 'main'
   AND type IN ('table', 'virtual')
   AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
   AND name <> 'hearthjs_migration';
